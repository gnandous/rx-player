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

import { BehaviorSubject } from "rxjs/BehaviorSubject";
import { Observable } from "rxjs/Observable";
import { Subject } from "rxjs/Subject";
import config from "../../config";
import log from "../../utils/log";
import { retryableFuncWithBackoff } from "../../utils/retry";
import throttle from "../../utils/rx-throttle";

import { onSourceOpen$ } from "../../compat/events";
import {
  CustomError,
  isKnownError,
  MediaError,
  OtherError,
} from "../../errors";
import Manifest, {
  ISupplementaryImageTrack,
  ISupplementaryTextTrack,
} from "../../manifest";
import { ITransportPipelines } from "../../net";
import ABRManager, {
  IABRMetric,
  IABRRequest,
} from "../abr";
import BufferManager from "../buffer";
import EMEManager, {
  IKeySystemOption,
} from "../eme";
import {
  createManifestPipeline,
  SegmentPipelinesManager,
} from "../pipelines";
import SourceBufferManager, {
  SourceBufferOptions,
} from "../source_buffers";
import { SupportedBufferTypes } from "../types";
import createBufferClock, {
  IStreamClockTick,
} from "./clock";
import createMediaSource, {
  setDurationToMediaSource,
} from "./create_media_source";
import GarbageCollectors from "./garbage_collector";
import getInitialTime, {
  IInitialTimeOptions,
} from "./get_initial_time";
import liveEventsHandler from "./live_events_handler";
import createMediaErrorHandler from "./media_error_handler";
import SegmentBookkeepers from "./segment_bookkeeper";
import SpeedManager from "./speed_manager";
import StallingManager from "./stalling_manager";
import EVENTS, {
  IStreamEvent,
} from "./stream_events";
import handleInitialVideoEvents from "./video_events";

import handleBuffers from "./handle_buffers";

const { END_OF_PLAY } = config;

export interface IStreamOptions {
  adaptiveOptions: {
    initialBitrates : Partial<Record<SupportedBufferTypes, number>>;
    manualBitrates : Partial<Record<SupportedBufferTypes, number>>;
    maxAutoBitrates : Partial<Record<SupportedBufferTypes, number>>;
    throttle : Partial<Record<SupportedBufferTypes, Observable<number>>>;
    limitWidth : Partial<Record<SupportedBufferTypes, Observable<number>>>;
  };
  autoPlay : boolean;
  bufferOptions : {
    wantedBufferAhead$ : Observable<number>;
    maxBufferAhead$ : Observable<number>;
    maxBufferBehind$ : Observable<number>;
  };
  errorStream : Subject<Error| CustomError>;
  speed$ : BehaviorSubject<number>;
  startAt? : IInitialTimeOptions;
  textTrackOptions : SourceBufferOptions;
  url : string;
  videoElement : HTMLMediaElement;
  withMediaSource : boolean;
  timings$ : Observable<IStreamClockTick>;
  supplementaryTextTracks : ISupplementaryTextTrack[];
  supplementaryImageTracks : ISupplementaryImageTrack[];
  keySystems : IKeySystemOption[];
  transport : ITransportPipelines<any, any, any, any, any>;
}

/**
 * Central part of the player. Play a given stream described by the given
 * manifest with given options.
 *
 * On subscription:
 *  - Creates the MediaSource and attached sourceBuffers instances.
 *  - download the content's manifest
 *  - Perform EME management if needed
 *  - get Buffers for each active adaptations.
 *  - give choice of the adaptation to the caller (e.g. to choose a language)
 *  - returns Observable emitting notifications about the stream lifecycle.
 *
 * @param {Object} args
 * @returns {Observable}
 */
export default function Stream({
  adaptiveOptions,
  autoPlay,
  bufferOptions,
  keySystems,
  speed$,
  startAt,
  url,
  videoElement,
  supplementaryImageTracks, // eventual manually added images
  supplementaryTextTracks, // eventual manually added subtitles
  errorStream, // subject through which minor errors are emitted TODO Remove?
  textTrackOptions,
  timings$,
  withMediaSource = true,
  transport,
} : IStreamOptions) : Observable<IStreamEvent> {

  const {
    wantedBufferAhead$,
    maxBufferAhead$,
    maxBufferBehind$,
  } = bufferOptions;

  /**
   * Fetch and parse the manifest from the URL given.
   * Throttled to avoid doing multiple simultaneous requests.
   * @param {string} url - the manifest url
   * @returns {Observable} - the parsed manifest
   */
  const fetchManifest = throttle(createManifestPipeline(
    transport,
    errorStream,
    supplementaryTextTracks,
    supplementaryImageTracks
  ));

  // TODO Move both of those with the source buffer part
  const garbageCollectors = new GarbageCollectors(
    timings$.map(timing => timing.currentTime),
    maxBufferBehind$,
    maxBufferAhead$
  );
  const segmentBookkeepers = new SegmentBookkeepers();

  /**
   * @see retryWithBackoff
   */
  const streamRetryOptions = {
    totalRetry: 3,
    retryDelay: 250,
    resetDelay: 60 * 1000,

    shouldRetry: (error : Error) => {
      if (isKnownError(error)) {
        return !error.fatal;
      }
      return true;
    },

    errorSelector: (error : Error|CustomError) => {
      if (!isKnownError(error)) {
        return new OtherError("NONE", error, true);
      }
      error.fatal = true;
      return error;
    },

    onRetry: (error : Error|CustomError, tryCount : number) => {
      log.warn("stream retry", error, tryCount);
      errorStream.next(error);
    },
  };

  /**
   * End-Of-Play emit when the current timing is really close to the end.
   * TODO Remove END_OF_PLAY
   * @see END_OF_PLAY
   * @type {Observable}
   */
  const endOfPlay = timings$
    .filter(({ currentTime, duration }) =>
      duration > 0 && duration - currentTime < END_OF_PLAY
    );

  /**
   * On subscription:
   *   - load the manifest (through its pipeline)
   *   - wiat for the given mediasource to be open
   * Once those are done, initialize the source duration and creates every
   * SourceBuffers and Buffers instances.
   *
   * This Observable can be retried on the basis of the streamRetryOptions
   * defined here.
   * @param {Object} params
   * @param {string} params.url
   * @param {MediaSource|null} params.mediaSource
   * @returns {Observable}
   */
  const startStreamWithRetry =
    retryableFuncWithBackoff<any, IStreamEvent>(startStream, streamRetryOptions);

  // TODO Find what to do with no media source.
  if (!withMediaSource) {
    return Observable.throw(new MediaError("UNAVAILABLE_MEDIA_SOURCE", null, true));
  }

  return createMediaSource(videoElement)
    .mergeMap(startStreamWithRetry)
    .takeUntil(endOfPlay);

  /**
   * Begin the stream logic, starting by fetching the manifest and waiting for
   * the MediaSource to emit its open event.
   * @param {MediaSource} mediaSource
   * @returns {Observable}
   */
  function startStream(mediaSource : MediaSource) {
    return Observable.combineLatest(fetchManifest(url), onSourceOpen$(mediaSource))
      .mergeMap(([manifest]) => initialize(mediaSource, manifest));
  }

  /**
   * Initialize stream playback by merging all observable that are required to
   * make the system cooperate.
   * @param {MediaSource} mediaSource
   * @param {Object} manifest
   * @returns {Observable}
   */
  function initialize(
    mediaSource : MediaSource,
    manifest : Manifest
  ): Observable<IStreamEvent> {
    setDurationToMediaSource(mediaSource, manifest.getDuration());

    log.debug("calculating initial time");
    const initialTime = getInitialTime(manifest, startAt);
    log.debug("initial time calculated:", initialTime);

    const firstPeriodToPlay = manifest.getPeriodForTime(initialTime);
    if (firstPeriodToPlay == null) {
      throw new MediaError("MEDIA_STARTING_TIME_NOT_FOUND", null, true);
    }

    const {
      hasDoneInitialSeek$,
      isLoaded$,
    } = handleInitialVideoEvents(videoElement, initialTime, autoPlay);

    const {
      clock$,
      seekings$,
    } = createBufferClock(manifest, timings$, hasDoneInitialSeek$, initialTime);

    /**
     * Subject through which network metrics will be sent by the segment
     * pipelines to the ABR manager.
     * @type {Subject}
     */
    const network$ = new Subject<IABRMetric>();

    /**
     * Subject through which each request progression will be sent by the
     * segment pipelines to the ABR manager.
     * @type {Subject}
     */
    const requestsInfos$ = new Subject<Subject<IABRRequest>>();

    /**
     * Creates pipelines for downloading segments.
     * @type {SegmentPipelinesManager}
     */
    const segmentPipelinesManager = new SegmentPipelinesManager(
      transport, requestsInfos$, network$, errorStream);

    /**
     * Create ABR Manager, which will choose the right "Representation" for a
     * given "Adaptation".
     * @type {ABRManager}
     */
    const abrManager = new ABRManager(requestsInfos$, network$, adaptiveOptions);

    /**
     * Creates BufferManager allowing to easily create a Buffer linked to any
     * Adaptation from the current content.
     * @type {BufferManager}
     */
    const bufferManager = new BufferManager(
      abrManager, timings$, speed$, seekings$, wantedBufferAhead$);

    /**
     * Creates SourceBufferManager allowing to create and keep track of a single
     * SourceBuffer per type.
     * @type {SourceBufferManager}
     */
    const sourceBufferManager = new SourceBufferManager(videoElement, mediaSource);

    /**
     * Creates Observable which will manage every Buffer for the given Content.
     * @type {Observable}
     */
    const handledBuffers$ = handleBuffers(
      { manifest, period: firstPeriodToPlay }, // content
      clock$,
      bufferManager,
      sourceBufferManager,
      segmentPipelinesManager,
      segmentBookkeepers,
      garbageCollectors,
      { text: textTrackOptions }, // sourceBufferOptions
      errorStream
    );

    /**
     * Add management of events linked to live Playback.
     * @type {Observable}
     */
    const buffers$ = (manifest.isLive ?
      handledBuffers$
        .mergeMap(liveEventsHandler(videoElement, manifest, fetchManifest)) :
      handledBuffers$);

    /**
     * Create EME Manager, an observable which will manage every EME-related
     * issue.
     * @type {Observable}
     */
    const emeManager$ = EMEManager(videoElement, keySystems, errorStream);

    /**
     * Translate errors coming from the video element into RxPlayer errors
     * through a throwing Observable.
     * @type {Observable}
     */
    const mediaErrorHandler$ = createMediaErrorHandler(videoElement);

    /**
     * Create Speed Manager, an observable which will set the speed set by the
     * user on the video element while pausing a little longer while the buffer
     * is stalled.
     * @type {Observable}
     */
    const speedManager$ = SpeedManager(videoElement, speed$, timings$, {
      pauseWhenStalled: withMediaSource,
    }).map(EVENTS.speedChanged);

    /**
     * Create Stalling Manager, an observable which will try to get out of
     * various infinite stalling issues
     * @type {Observable}
     */
    const stallingManager$ = StallingManager(videoElement, manifest, timings$)
      .map(EVENTS.stalled);

    // Single lifecycle events
    const streamStartedEvent$ = Observable.of(EVENTS.started(abrManager, manifest));
    const loadedEvent$ = isLoaded$.mapTo(EVENTS.loaded());

    return Observable.merge(
      streamStartedEvent$,
      loadedEvent$,
      buffers$,
      emeManager$,
      mediaErrorHandler$,
      speedManager$,
      stallingManager$
    ).finally(() => {
      sourceBufferManager.disposeAll();
    });
  }
}

export {
  IStreamEvent,
};
