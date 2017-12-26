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
import { ErrorTypes } from "../../errors";
import Manifest, {
} from "../../manifest";
import Adaptation from "../../manifest/adaptation";
import Period from "../../manifest/period";
import Representation from "../../manifest/representation";
import { ISegmentLoaderArguments } from "../../net/types";
import log from "../../utils/log";
import ABRManager from "../abr";
import QueuedSourceBuffer from "../source_buffers/queued_source_buffer";
import { SegmentBookkeeper } from "../stream/segment_bookkeeper";
import { SupportedBufferTypes } from "../types";
import RepresentationBuffer, {
  IAddedSegmentEvent,
  IBufferActiveEvent,
  IBufferClockTick,
  IBufferFullEvent,
  IDiscontinuityEvent,
  INeedingManifestRefreshEvent,
  IRepresentationBufferEvent,
} from "./representation_buffer";

export interface IAdaptationBufferClockTick {
  bufferGap : number;
  currentTime : number;
  duration : number;
}

export interface IBitrateEstimationChangeEvent {
  type : "bitrateEstimationChange";
  value : {
    type : SupportedBufferTypes;
    bitrate : number|undefined;
  };
}

export interface IRepresentationChangeEvent {
  type : "representationChange";
  value : {
    type : SupportedBufferTypes;
    representation : Representation|null;
  };
}

export type IAdaptationBufferEvent =
  IBitrateEstimationChangeEvent |
  IRepresentationBufferEvent |
  IRepresentationChangeEvent;

/**
 * Allows to create Buffers, each being linked to a single adaptation.
 *
 * They will download the right segments in the representations chosen by the
 * ABRManager.
 *
 * @example
 * ```js
 * const bufferManager = new AdaptationBufferManager(
 *   abrManager,
 *   abrClock$,
 *   speed$,
 *   seekings$,
 *   wantedBufferAhead$
 * );
 *
 * const buffer$ = bufferManager.createBuffer(
 *  bufferClock$,
 *  queuedSourceBuffer,
 *  segmentBookkeeper,
 *  pipeline,
 *  { manifest, period, adaptation},
 * );
 * ```
 * @class AdaptationBufferManager
 */
export default class AdaptationBufferManager {
  private _abrManager : ABRManager;
  private _abrBaseClock$ : Observable<IAdaptationBufferClockTick>;
  private _speed$ : BehaviorSubject<number>;
  private _seeking$ : Observable<null>;
  private _wantedBufferAhead$ : Observable<number>;

  /**
   * @param {ABRManager} abrManager
   * @param {Observable} abrBaseClock$ - Clock$ at which the ABR manager will
   * make estimates.
   * @param {BehaviorSubject} speed$ - emits the speed each time it changes
   * @param {Observable} seeking$ - emits each time the user seeks
   * @param {Observable} wantedBufferAhead$ - emits the buffer goal
   * @param {Subject} warnings$ - Subject to emit non-fatal errors
   */
  constructor(
    abrManager : ABRManager,
    abrBaseClock$ : Observable<IAdaptationBufferClockTick>,
    speed$ : BehaviorSubject<number>,
    seeking$ : Observable<null>,
    wantedBufferAhead$ : Observable<number>
  ) {
    this._abrManager = abrManager;
    this._abrBaseClock$ = abrBaseClock$;
    this._speed$ = speed$;
    this._seeking$ = seeking$;
    this._wantedBufferAhead$ = wantedBufferAhead$;
  }

  /**
   * Create new Buffer Observable linked to the given Adaptation.
   *
   * Multiple buffers can be created at the same time on the same
   * QueuedSourceBuffer.
   * This allows for example smooth streaming between multiple periods.
   * @param {Observable} bufferClock$
   * @param {QueuedSourceBuffer} queuedSourceBuffer
   * @param {SegmentBookkeeper} segmentBookkeeper
   * @param {Function} pipeline
   * @param {Object} content
   * @returns {Observable}
   */
  createBuffer(
    bufferClock$ : Observable<IBufferClockTick>,
    queuedSourceBuffer : QueuedSourceBuffer<any>,
    segmentBookkeeper : SegmentBookkeeper,
    pipeline : (content : ISegmentLoaderArguments) => Observable<any>,
    content : { manifest : Manifest; period : Period; adaptation : Adaptation }
  ) : Observable<IAdaptationBufferEvent> {
    const wantedBufferAhead$ = this._wantedBufferAhead$;
    const { manifest, period, adaptation } = content;
    const abr$ = this._getABRForAdaptation(manifest, adaptation);

    const representation$ = abr$
      .map(abr => abr.representation)
      .distinctUntilChanged((a, b) =>
        !a || !b || (a.bitrate === b.bitrate && a.id === b.id)
      ) as Observable<Representation>;

    const shouldSwitchRepresentationBuffer$ : Observable<Representation> =
      Observable.combineLatest(representation$, this._seeking$)
        .map(([representation]) => representation);

    function createRepresentationBuffer(
      representation : Representation
    ) : Observable<IRepresentationBufferEvent> {

      log.info("changing representation", adaptation.type, representation);
      return RepresentationBuffer({
        clock$: bufferClock$,
        content: {
          representation,
          adaptation,
          period,
          manifest,
        },
        queuedSourceBuffer,
        segmentBookkeeper,
        pipeline,
        wantedBufferAhead$,
      })
      .catch((error) => {
        // TODO only for smooth?
        // for live adaptations, handle 412 errors as precondition-
        // failed errors, ie: we are requesting for segments before they
        // exist
        // (In case of smooth streaming, 412 errors are requests that are
        // performed to early).
        if (
          !manifest.isLive ||
          error.type !== ErrorTypes.NETWORK_ERROR ||
          !error.isHttpError(412)
        ) {
          throw error;
        }

        manifest.updateLiveGap(1); // go back 1s for now
        log.warn("precondition failed", manifest.presentationLiveGap);

        return Observable.timer(2000)
          .mergeMap(() => createRepresentationBuffer(representation));
      });
    }

    const buffer$ = shouldSwitchRepresentationBuffer$
      .switchMap((representation) =>
        Observable.of({
          type: "representationChange" as "representationChange",
          value: {
            type: adaptation.type,
            representation,
          },
        }).concat(createRepresentationBuffer(representation))
      );

    const bitrateEstimate$ = abr$
      .filter(({ bitrate } : { bitrate? : number }) => bitrate != null)
      .map(({ bitrate } : { bitrate? : number }) => {
        return {
          type: "bitrateEstimationChange" as "bitrateEstimationChange",
          value: {
            type: adaptation.type,
            bitrate,
          },
        };
      });
    return Observable.merge(buffer$, bitrateEstimate$);
  }

  private _getABRForAdaptation(
    manifest : Manifest,
    adaptation : Adaptation
  ) {
    const representations = adaptation.representations;

    /**
     * Keep track of the current representation to add informations to the
     * ABR clock.
     * TODO isn't that a little bit ugly?
     * @type {Object|null}
     */
    let currentRepresentation : Representation|null = null;

    const abrClock$ = this._abrBaseClock$.map(timing => {
      let bitrate;
      let lastIndexPosition;

      if (currentRepresentation) {
        bitrate = currentRepresentation.bitrate;

        if (currentRepresentation.index) {
          lastIndexPosition =
            currentRepresentation.index.getLastPosition();
        }
      }

      return {
        bufferGap: timing.bufferGap,
        duration: timing.duration,
        position: timing.currentTime,
        bitrate,
        isLive: manifest.isLive,
        lastIndexPosition,
        speed: this._speed$.getValue(),
      };
    });

    return this._abrManager.get$(adaptation.type, abrClock$, representations)
      .do(({ representation }) => {
        currentRepresentation = representation;
      });
  }
}

export {
  IAddedSegmentEvent,
  IBufferActiveEvent,
  IBufferClockTick,
  IBufferFullEvent,
  IDiscontinuityEvent,
  INeedingManifestRefreshEvent,
};
