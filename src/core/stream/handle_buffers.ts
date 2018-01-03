/**
 * Copyright 2015 CANAL+ Group
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Observable } from "rxjs/Observable";
import { ReplaySubject } from "rxjs/ReplaySubject";
import { Subject } from "rxjs/Subject";
import {
  CustomError,
  MediaError,
} from "../../errors";
import Manifest, {
  Adaptation,
  Period,
} from "../../manifest";
import arrayIncludes from "../../utils/array-includes";
import InitializationSegmentCache from "../../utils/initialization_segment_cache";
import log from "../../utils/log";
import WeakMapMemory from "../../utils/weak_map_memory";
import BufferManager, {
  IAdaptationBufferEvent,
  IBufferClockTick,
} from "../buffer";
import {
  IPipelineOptions,
  SegmentPipelinesManager,
} from "../pipelines";
import SourceBufferManager, {
  QueuedSourceBuffer,
  SourceBufferOptions,
} from "../source_buffers";
import { SupportedBufferTypes } from "../types";
import PeriodList from "./periods_list";
import SegmentBookkeeper from "./segment_bookkeeper";
import EVENTS, {
  IStreamEvent,
} from "./stream_events";

/**
 * Create and manage the various Buffer Observables needed for the content to
 * stream:
 *
 *   - Create or dispose SourceBuffers depending on the chosen adaptations.
 *
 *   - Concatenate Buffers for adaptation from separate Periods at the right
 *     time, to allow smooth transitions between periods.
 *
 *   - Emit events as Period or Adaptations change or as new Period are
 *     prepared.
 *
 * Here multiple buffers can be created at the same time to allow smooth
 * transitions between periods.
 * To do this, we dynamically create or destroy buffers as they are needed.
 *
 * ---- EXAMPLE ----
 *
 * Basically let's imagine a regular case, with two periods.
 *
 * Let's say that the Buffer for the first period (named B1) is currently
 * actively downloading segments (the "^" sign is the current position):
 *    B1
 * |====  |
 *    ^
 *
 * Once B1 is full (it has no segment left to download):
 *    B1
 * |======|
 *    ^
 *
 * We will be able to create a new Buffer for the second period:
 *    B1     B2
 * |======|      |
 *    ^
 *
 * Which will then also download segments:
 *    B1     B2
 * |======|==    |
 *    ^
 *
 * If B1 needs segments again however (e.g. we change the bitrate, the
 * language etc.):
 *    B1     B2
 * |===   |==    |
 *    ^
 *
 * Then we will destroy B2, to keep it from downloading segments:
 *    B1
 * |===   |
 *    ^
 * (Here only Buffer observables are destroyed/created. The segments already
 * pushed do not move).
 *
 * ----
 *
 * When the current position go ahead of a Buffer (here ahead of B1):
 *    B1     B2
 * |======|===   |
 *         ^
 *
 * This Buffer is destroyed to free up ressources:
 *           B2
 *        |===   |
 *         ^
 *
 * ----
 *
 * When the current position goes behind the first currently defined Buffer:
 *           B2
 *        |===   |
 *     ^
 *
 * Then we destroy all previous buffers and [re-]create the one needed:
 *    B1
 * |======|
 *     ^
 *
 * In this example, B1 is full so we also can re-create B2, which will also keep
 * its already-pushed segments:
 *    B1     B2
 * |======|===   |
 *     ^
 *
 * ----
 *
 * At the end, we should only have Buffer[s] for consecutive Period[s].
 * The last one should always be the only one downloading content.
 * The first one should always be the one currently seen by the user.
 *
 * @param {Observable} clock$ - Emit current informations about the content
 * being played. Also regulate the frequencies of the time the Buffer check
 * for new its status / new segments.
 * @param {BufferManager} bufferManager
 * @param {Object} content
 * @param {Manifest} content.manifest
 * @param {Period} content.period - The first period to play in the content
 * @param {SourceBufferManager} sourceBufferManager - Will be used to create
 * and dispose SourceBuffer instances associated with the current video.
 * @param {SegmentPipelinesManager} segmentPipelinesManager
 * @param {WeakMapMemory} segmentBookkeeper - Allow to easily retrieve
 * or create a unique SegmentBookkeeper per SourceBuffer
 * @param {WeakMapMemory} garbageCollectors - Allows to easily create a
 * unique Garbage Collector per SourceBuffer
 * @param {Object} sourceBufferOptions - Every SourceBuffer options, per type
 * @param {Subject} errorStream - Subject to emit minor errors
 */
export default function handleBuffers(
  { manifest, period: firstPeriod } : { manifest : Manifest; period : Period },
  clock$ : Observable<IBufferClockTick>,
  bufferManager : BufferManager,
  sourceBufferManager : SourceBufferManager,
  segmentPipelinesManager : SegmentPipelinesManager,
  segmentBookkeepers : WeakMapMemory<QueuedSourceBuffer<any>, SegmentBookkeeper>,
  garbageCollectors : WeakMapMemory<QueuedSourceBuffer<any>, Observable<never>>,
  sourceBufferOptions : Partial<Record<SupportedBufferTypes, SourceBufferOptions>>,
  errorStream : Subject<Error | CustomError>
) : Observable<IStreamEvent> { // XXX TODO
  // Initialize all native source buffers from the first period at the same
  // time.
  // We cannot lazily create native sourcebuffers since the spec does not
  // allow adding them during playback.
  //
  // From https://w3c.github.io/media-source/#methods
  //    For example, a user agent may throw a QuotaExceededError
  //    exception if the media element has reached the HAVE_METADATA
  //    readyState. This can occur if the user agent's media engine
  //    does not support adding more tracks during playback.
  createNativeSourceBuffersForPeriod(sourceBufferManager, firstPeriod);

  const buffersArray = Object.keys(firstPeriod.adaptations)
    .map((adaptationType) => {
      // :/ TS does not have the intelligence to know that here
      const bufferType = adaptationType as SupportedBufferTypes;
      return manageAllBuffers(bufferType, firstPeriod);
    });

  return Observable.merge(...buffersArray);

  /**
   * Manage creation and removal of Buffers for every Periods.
   *
   * Works by creating consecutive buffers through the manageConsecutiveBuffers
   * function, and restarting it when the clock goes out of the bounds of these
   * buffers.
   * @param {string} bufferType - e.g. "audio" or "video"
   * @param {Period} basePeriod - Initial Period downloaded.
   * @returns {Observable}
   */
  function manageAllBuffers(
    bufferType : SupportedBufferTypes,
    basePeriod : Period
  ) : Observable<IStreamEvent> {
    /**
     * Keep a PeriodList for cases such as seeking ahead/before the
     * buffers already created.
     * When that happens, interrupt the previous buffers and create one back
     * from the new initial period.
     * @type {ConsecutivePeriodList}
     */
    const periodList = new PeriodList();

    /**
     * Destroy the current set of consecutive buffers.
     * Used when the clocks goes out of the bounds of those, e.g. when the user
     * seeks.
     * We can then re-create consecutive buffers, from the new point in time.
     * @type {Subject}
     */
    const destroyCurrentBuffers = new Subject<void>();

    const restartBuffers$ = clock$
      .filter(({ currentTime, timeOffset }) =>
        periodList.isOutOfBounds(currentTime + timeOffset)
      )
      .take(1)
      .do(({ currentTime, timeOffset }) => {
        log.info("Current position out of the bounds of the active periods," +
          "re-creating buffers.", bufferType, currentTime + timeOffset);
        destroyCurrentBuffers.next();
      })
      .mergeMap(({ currentTime, timeOffset }) => {
        const newInitialPeriod = manifest.getPeriodForTime(currentTime + timeOffset);
        if (newInitialPeriod == null) {
          throw new MediaError("MEDIA_TIME_NOT_FOUND", null, true);
        }

        // Note: For this to work, manageAllBuffers should always emit the
        // "periodReady" event for the newInitialPeriod synchronously
        return manageAllBuffers(bufferType, newInitialPeriod);
      });

    const currentBuffers$ = manageConsecutiveBuffers(
      bufferType,
      basePeriod,
      destroyCurrentBuffers
    ).do((message) => {
      if (message.type === "periodReady") {
        log.error("XXX READY", bufferType, message.value.period);
        periodList.add(message.value.period);
      } else if (message.type === "finishedPeriod") {
        log.error("XXX FINISHED", bufferType, message.value.period);
        periodList.remove(message.value.period);
      }
    });

    return Observable.merge(currentBuffers$, restartBuffers$);
  }

  /**
   * Manage creation and removal of Buffers for consecutive Periods.
   *
   * This function is called recursively for each successive Periods as needed.
   *
   * This function does not guarantee creation/destruction of the right Buffers
   * when the user seeks or rewind in the content.
   * It only manages regular playback, another layer should be used to manage
   * those cases.
   *
   * You can know about buffers creation and destruction respectively through
   * the "periodReady" and "finishedPeriod" events.
   *
   * The "periodReady" related to the given period should be sent synchronously
   * on subscription.
   * Further "periodReady" for further Periods should be sent each time the
   * Buffer for the previous Buffer is full.
   *
   * Buffers for each Period are finished ("finishedPeriod" event) either:
   *   - when it has finished to play (currentTime is after it)
   *   - when one of the older Buffers becomes active again, in which case the
   *     Buffers coming after will be finished from the newest to the oldest.
   *   - when the destroy$ observable emits, in which case every created Buffer
   *     here will be finished from the newest to the oldest.
   *
   * TODO The code here can surely be greatly simplified.
   * @param {string} bufferType - e.g. "audio" or "video"
   * @param {Period} basePeriod - Initial Period downloaded.
   * @param {Observable} destroy$ - Emit when/if all created Buffer from this
   * point should be destroyed.
   * @returns {Observable}
   */
  function manageConsecutiveBuffers(
    bufferType : SupportedBufferTypes,
    basePeriod : Period,
    destroy$ : Observable<void>
  ) : Observable<IStreamEvent> {
    log.info("creating new Buffer for", bufferType, basePeriod);

    /**
     * Emit the chosen adaptation for the current type.
     * @type {ReplaySubject}
     */
    const adaptation$ = new ReplaySubject<Adaptation|null>(1);

    /**
     * The Period coming just after the current one.
     * @type {Period|undefined}
     */
    const nextPeriod = manifest.getPeriodAfter(basePeriod);

    /**
     * Will emit when the Buffer for the next Period can be created.
     * @type {Subject}
     */
    const createNextBuffers$ = new Subject<void>();

    /**
     * Will emit when the Buffers for the next Periods should be destroyed, if
     * created.
     * @type {Subject}
     */
    const destroyNextBuffers$ = new Subject<void>();

    /**
     * Emit when the current position goes over the end of the current buffer.
     * @type {Subject}
     */
    const endOfCurrentBuffer$ = clock$
      .filter(({ currentTime, timeOffset }) =>
        !!basePeriod.end && (currentTime + timeOffset) >= basePeriod.end
      );

    /**
     * Prepare Buffer for the next Period.
     * @type {Observable}
     */
    const nextPeriodBuffer$ = createNextBuffers$
      .exhaustMap(() => {
        if (!nextPeriod || nextPeriod === basePeriod) {
          return Observable.empty(); // finished
        }
        return manageConsecutiveBuffers(bufferType, nextPeriod, destroyNextBuffers$);
      });

    /**
     * Allows to destroy each created Buffer, from the newest to the oldest,
     * once destroy$ emits.
     * @type {Observable}
     */
    const destroyAll$ = destroy$
      .take(1)
      .do(() => {
        // first complete createNextBuffer$ to allow completion of the
        // nextPeriodBuffer$ observable once every further Buffers have been
        // finished.
        createNextBuffers$.complete();

        // emit destruction signal to the next Buffer first
        destroyNextBuffers$.next();
        destroyNextBuffers$.complete(); // we do not need it anymore
      }).share();

    /**
     * Will emit when the current buffer should be destroyed.
     * @type {Observable}
     */
    const killCurrentBuffer$ = Observable.merge(endOfCurrentBuffer$, destroyAll$);

    /**
     * Buffer for the current Period.
     * @type {Observable}
     */
    const periodBuffer$ = createBufferForPeriod(bufferType, basePeriod, adaptation$)
      .do(({ type }) => {
        if (type === "full") {
          // current buffer is full, create the next one if not
          createNextBuffers$.next();
        } else if (type === "segments-queued") {
          // current buffer is active, destroy next buffer if created
          destroyNextBuffers$.next();
        }
      })
      .share()
      .takeUntil(killCurrentBuffer$)
      .startWith(EVENTS.periodReady(bufferType, basePeriod, adaptation$))
      .concat(
        Observable.of(EVENTS.finishedPeriod(bufferType, basePeriod))
          .do(() => {
            log.info("destroying buffer for", bufferType, basePeriod);
          })
      );

    return Observable.merge(
      periodBuffer$,
      nextPeriodBuffer$,
      destroyAll$.ignoreElements()
    ) as
      Observable<IStreamEvent>;
  }

  /**
   * Create single Buffer Observable for the entire Period.
   * @param {string} bufferType
   * @param {Period} period - The period concerned
   * @param {Observable} adaptation$ - Emit the chosen adaptation.
   * Emit null to deactivate a type of adaptation
   * @returns {Observable}
   */
  function createBufferForPeriod(
    bufferType : SupportedBufferTypes,
    period: Period,
    adaptation$ : Observable<Adaptation|null>
  ) : Observable<IStreamEvent> {
    return adaptation$.switchMap((adaptation) => {

      if (adaptation == null) {
        return disposeSourceBuffer(bufferType, sourceBufferManager, period);
      }

      log.info(`updating ${bufferType} adaptation`, adaptation);

      // 1 - create or reuse the SourceBuffer
      const codec = getFirstDeclaredMimeType(adaptation);
      const options = sourceBufferOptions[bufferType] || {};
      const queuedSourceBuffer = sourceBufferManager
        .createSourceBuffer(bufferType, codec, options);

      // 2 - create or reuse its associated BufferGarbageCollector and
      // SegmentBookkeeper
      const bufferGarbageCollector$ = garbageCollectors.get(queuedSourceBuffer);
      const segmentBookkeeper = segmentBookkeepers.get(queuedSourceBuffer);

      // 3 - create the pipeline
      const pipelineOptions = getPipelineOptions(bufferType);
      const pipeline = segmentPipelinesManager
        .createPipeline(bufferType, pipelineOptions);

      // 4 - create the Buffer
      const adaptationBuffer$ = bufferManager.createBuffer(
        clock$,
        queuedSourceBuffer,
        segmentBookkeeper,
        pipeline,
        { manifest, period, adaptation }
      ).catch<IAdaptationBufferEvent, never>((error : Error) => {
        // non native buffer should not impact the stability of the
        // player. ie: if a text buffer sends an error, we want to
        // continue streaming without any subtitles
        if (!SourceBufferManager.isNative(bufferType)) {
          log.error("custom buffer: ", bufferType,
            "has crashed. Aborting it.", error);
          errorStream.next(error);
          return Observable.empty();
        }

        log.error(
          "native buffer: ", bufferType, "has crashed. Stopping playback.", error);
        throw error; // else, throw
      });

      // 5 - Return the buffer and send right events
      return Observable
        .of(EVENTS.adaptationChange(bufferType, adaptation, period))
        .concat(Observable.merge(adaptationBuffer$, bufferGarbageCollector$));
    });
  }
}

/**
 * Returns the pipeline options depending on the type of pipeline concerned.
 * @param {string} bufferType - e.g. "audio"|"text"...
 * @returns {Object} - Options to give to the Pipeline
 */
function getPipelineOptions(bufferType : string) : IPipelineOptions<any, any> {
  const downloaderOptions : IPipelineOptions<any, any> = {};

  if (arrayIncludes(["audio", "video"], bufferType)) {
    downloaderOptions.cache = new InitializationSegmentCache();
  } else if (bufferType === "image") {
    downloaderOptions.maxRetry = 0; // Deactivate BIF fetching if it fails
  }
  return downloaderOptions;
}

/**
 * Get mimetype string of the first representation declared in the given
 * adaptation.
 * @param {Adaptation} adaptation
 * @returns {string}
 */
function getFirstDeclaredMimeType(adaptation : Adaptation) : string {
  const { representations } = adaptation;
  return (
    representations[0] && representations[0].getMimeTypeString()
  ) || "";
}

/**
 * Create all native SourceBuffers needed for a given Period.
 * @param {SourceBufferManager} sourceBufferManager
 * @param {Period} period
 */
function createNativeSourceBuffersForPeriod(
  sourceBufferManager : SourceBufferManager,
  period : Period
) : void {
  Object.keys(period.adaptations).map(bufferType => {
    if (SourceBufferManager.isNative(bufferType)) {
      const adaptations = period.adaptations[bufferType] || [];
      const representations = adaptations ?
        adaptations[0].representations : [];
      if (representations.length) {
        const codec = representations[0].getMimeTypeString();
        sourceBufferManager.createSourceBuffer(bufferType, codec);
      }
    }
  });
}

/**
 * @param {string} bufferType
 * @param {SourceBufferManager} sourceBufferManager
 * @returns {Observable}
 */
function disposeSourceBuffer(
  bufferType : SupportedBufferTypes,
  sourceBufferManager : SourceBufferManager,
  period : Period
) {
  log.info(`disposing ${bufferType} adaptation`);
  sourceBufferManager.dispose(bufferType);

  return Observable
    .of(EVENTS.adaptationChange(bufferType, null, period))
    .concat(Observable.of(EVENTS.nullRepresentation(bufferType, period)));
}
