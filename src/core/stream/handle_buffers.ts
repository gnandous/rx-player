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
import { CustomError } from "../../errors";
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
      return preparePeriod(bufferType, firstPeriod);
    });

  return Observable.merge(...buffersArray);

  /**
   * Begin Buffer(s) for a bufferType from a particular period.
   * @param {string} bufferType
   * @param {Period} currentPeriod
   */
  function preparePeriod(
    bufferType : SupportedBufferTypes,
    currentPeriod : Period
  ) : Observable<IStreamEvent> {
    /**
     * Emit the chosen adaptation for the current type.
     * @type {ReplaySubject}
     */
    const adaptation$ = new ReplaySubject<Adaptation|null>(1);

    /**
     * Will emit when the current buffer is not needed anymore and
     * can be destroyed.
     * @type {Subject}
     */
    const destroyCurrentBuffer$ = new Subject();

    /**
     * Will emit when the Buffer for the next Period can be created.
     * @type {Subject}
     */
    const createNextBuffer$ = new Subject();

    /**
     * Will emit when the Buffer for the next Period should be destroyed if
     * created.
     * @type {Subject}
     */
    const destroyNextBuffer$ = new Subject();

    /**
     * Buffer for the next Period.
     *
     * Created when the Buffer for the current Buffer is full.
     * Destroyed when the Buffer for the current Buffer is active.
     * @type {Observable}
     */
    const nextBuffer$ = createNextBuffer$
      .exhaustMap(() => {
        const newPeriod = manifest.getPeriodAfter(currentPeriod);
        if (!newPeriod || newPeriod === currentPeriod) {
          // finished
          return Observable.empty();
        }

        log.info("creating new Buffer for", bufferType, newPeriod);
        return preparePeriod(bufferType, newPeriod)
          .takeUntil(destroyNextBuffer$);
      });

    /**
     * Buffer for the current Period.
     * @type {Observable}
     */
    const periodBuffer$ = createBufferForPeriod(bufferType, currentPeriod, adaptation$)
      .do(({ type }) => {
        if (type === "full") {
          createNextBuffer$.next();
        } else if (type === "segments-queued") {
          destroyNextBuffer$.next();
        }
      })
      .share()
      .takeUntil(destroyCurrentBuffer$);

    /**
     * Observable destroying the current buffer when no longer needed.
     * @type {Observable}
     */
    const destroyBuffer$ = clock$
      .do((tick) => {
        if (currentPeriod.end && tick.currentTime > currentPeriod.end) {
          log.info("destroying buffer for", bufferType, currentPeriod);
          // destroyCurrentBuffer$.next();
        }
      })
      .takeUntil(destroyCurrentBuffer$)
      .ignoreElements();

    // XXX TODO Ask the API for the wanted adaptation
    const adaptationsArr = currentPeriod.adaptations[bufferType];
    adaptation$.next(adaptationsArr ? adaptationsArr[0] : null);

    return Observable.merge(
      periodBuffer$,
      nextBuffer$,
      destroyBuffer$
    ) as Observable<IStreamEvent>;
  }

  /**
   * Create single Buffer Observable for the entire Period.
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
        return disposeSourceBuffer(bufferType, sourceBufferManager);
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
        .of(EVENTS.adaptationChange(bufferType, adaptation))
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
  sourceBufferManager : SourceBufferManager
) {
  log.info(`disposing ${bufferType} adaptation`);
  sourceBufferManager.dispose(bufferType);

  return Observable
    .of(EVENTS.adaptationChange(bufferType, null))
    .concat(Observable.of(EVENTS.nullRepresentation(bufferType)));
}
