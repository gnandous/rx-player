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

/**
 * This file and directory defines the public API for the RxPlayer.
 *
 * It also starts the different sub-parts of the player on various API calls.
 */

import deepEqual = require("deep-equal");
import { BehaviorSubject } from "rxjs/BehaviorSubject";
import { Observable } from "rxjs/Observable";
import { ReplaySubject } from "rxjs/ReplaySubject";
import { Subject } from "rxjs/Subject";
import { Subscription } from "rxjs/Subscription";
import config from "../../config";
import assert from "../../utils/assert";
import EventEmitter from "../../utils/eventemitter";
import log, { ILogger } from "../../utils/log";
import noop from "../../utils/noop";
import {
  getLeftSizeOfRange,
  getPlayedSizeOfRange,
  getSizeOfRange,
} from "../../utils/ranges";
import SortedList from "../../utils/sorted_list";

import {
  exitFullscreen,
  isFullscreen,
  requestFullscreen,
} from "../../compat";
import {
  isInBackground$,
  onFullscreenChange$,
  onPlayPause$,
  onTextTrackChanges$,
  videoWidth$,
} from "../../compat/events";
import {
  CustomError,
  ErrorCodes,
  ErrorTypes,
} from "../../errors";
import Manifest, {
  Adaptation,
  Period,
  Representation,
} from "../../manifest";
import {
  fromWallClockTime,
  getMaximumBufferPosition,
  getMinimumBufferPosition,
  toWallClockTime,
} from "../../manifest/timings";
import Transports from "../../net";
import { IBifThumbnail } from "../../parsers/images/bif";
import ABRManager from "../abr";
import {
  clearEME,
  dispose as emeDispose,
  getCurrentKeySystem,
} from "../eme";
import Stream, {
  IStreamEvent,
} from "../stream";
import { SupportedBufferTypes } from "../types";
import createClock, {
  IClockTick
} from "./clock";
import { PLAYER_STATES } from "./constants";
import LanguageManager, {
  IAudioTrackConfiguration,
  ILMAudioTrack,
  ILMAudioTrackList,
  ILMTextTrack,
  ILMTextTrackList,
  ITextTrackConfiguration,
} from "./language_manager";
import {
  IConstructorOptions,
  ILoadVideoOptions,
  parseConstructorOptions,
  parseLoadVideoOptions,
} from "./option_parsers";

const {
  DEFAULT_UNMUTED_VOLUME,
} = config;

interface IPositionUpdateItem {
  position : number;
  duration : number;
  playbackRate : number;
  bufferGap : number;
  wallClockTime? : number;
  liveGap? : number;
}

/**
 * @class Player
 * @extends EventEmitter
 */
class Player extends EventEmitter {
  /**
   * Current version of the RxPlayer.
   * @type {string}
   */
  public readonly version : string;

  /**
   * Video element attached to the RxPlayer.
   * @type {HTMLMediaElement|null}
   */
  public videoElement : HTMLMediaElement|null; // null on dispose

  /**
   * Logger the RxPlayer uses.
   * @type {Object}
   */
  public log : ILogger;

  /**
   * Current state of the RxPlayer.
   * @type {string}
   */
  public state : string;

  /**
   * Emit when the player is disposed to perform clean-up.
   * @private
   * @type {Subject}
   */
  private _priv_destroy$ : Subject<void>;

  /**
   * Emit when a video is stopped to perform clean-up.
   * @private
   * @type {Subject}
   */
  private _priv_unsubscribeLoadedVideo$ : Subject<void>;

  /**
   * Emit true when the Stream is cleaning-up and thus cannot be re-created
   * before this asynchronous process is finished.
   * @private
   * @type {BehaviorSubject}
   */
  private _priv_streamLock$ : BehaviorSubject<boolean>;

  /**
   * Emit warnings coming from the Stream.
   * TODO Use regular Stream observable for that?
   * @private
   * @type {Subject}
   */
  private _priv_errorStream$ : Subject<Error|CustomError>;

  /**
   * Emit false when the player is into a "paused" state, true when it goes into
   * a "playing" state.
   * @private
   * @type {ReplaySubject}
   */
  private _priv_playing$ : ReplaySubject<boolean>;

  /**
   * Last speed set by the user.
   * Used instead of videoElement.playbackRate to allow more flexibility.
   * @private
   * @type {BehaviorSubject>}
   */
  private _priv_speed$ : BehaviorSubject<number>;

  /**
   * Wanted buffer goal.
   * @private
   * @type {BehaviorSubject}
   */
  private _priv_wantedBufferAhead$ : BehaviorSubject<number>;

  /**
   * Maximum kept buffer ahead in the current position, in seconds.
   * @private
   * @type {BehaviorSubject}
   */
  private _priv_maxBufferAhead$ : BehaviorSubject<number>;

  /**
   * Maximum kept buffer behind in the current position, in seconds.
   * @private
   * @type {BehaviorSubject}
   */
  private _priv_maxBufferBehind$ : BehaviorSubject<number>;

  /**
   * Store last bitrates for each type for ABRManager instanciation.
   * Store the initial wanted bitrates at first.
   * @private
   * @type {Object}
   */
  private _priv_lastBitrates : {
    audio? : number;
    video? : number;
    text? : number;
    image? : number;
  };

  /**
   * Store last wanted maxAutoBitrates for the next ABRManager instanciation.
   * @private
   * @type {Object}
   */
  private _priv_initialMaxAutoBitrates : {
    audio : number; // has a default in the config
    video : number; // has a default in the config
    text? : number;
    image? : number;
  };

  /**
   * Store last wanted manual bitrates for the next ABRManager instanciation.
   * @private
   * @type {Object}
   */
  private _priv_manualBitrates : {
    audio : number; // has a default in the config
    video : number; // has a default in the config
    text? : number;
    image? : number;
  };

  /**
   * Store every active Periods.
   *
   * The rules are the same than in lower layers:
   *   - The first active Period is the currently played one
   *   - Any subsequent one are pre-loaded period, consecutive in chronological
   *     order.
   *
   * null if no period is active
   * @private
   * @type {SortedList}
   */
  private _priv_activePeriods : SortedList<Period> | null;

  /**
   * Store current adaptations for the loaded content.
   *
   * null if no adaptation is active
   * @private
   * @type {Map}
   */
  private _priv_activeAdaptations : Map<Period, {
    audio? : Adaptation|null;
    video? : Adaptation|null;
    text? : Adaptation|null;
    image? : Adaptation|null;
  }> | null;

  /**
   * Store currently downloaded representations per active period.
   *
   * null if no representation is active
   * @private
   * @type {Map}
   */
  private _priv_activeRepresentations : Map<Period, {
    audio? : Representation|null;
    video? : Representation|null;
    text? : Representation|null;
    image? : Representation|null;
  }> | null;

  /**
   * Store wanted configuration for the limitVideoWidth option.
   * @private
   * @type {boolean}
   */
  private readonly _priv_limitVideoWidth : boolean;

  /**
   * Store wanted configuration for the throttleWhenHidden option.
   * @private
   * @type {boolean}
   */
  private readonly _priv_throttleWhenHidden : boolean;

  /**
   * Store volume when mute is called, to restore it on unmute.
   * @private
   * @type {Number}
   */
  private _priv_mutedMemory : number;

  /**
   * Store default audio track for a loaded content.
   * @private
   * @type {undefined|null|Object}
   */
  private _priv_initialAudioTrack : undefined|null|IAudioTrackConfiguration;

  /**
   * Store default text track for a loaded content.
   * @private
   * @type {undefined|null|Object}
   */
  private _priv_initialTextTrack : undefined|null|ITextTrackConfiguration;

  /**
   * LanguageManager instance linked to the current content.
   * Null if no content has been loaded or if the current content loaded
   * has no LanguageManager.
   * @private
   * @type {Object|null}
   */
  private _priv_languageManager : LanguageManager|null;

  /**
   * ABRManager instance linked to the current content.
   * Null if no content has been loaded or if the current content loaded
   * has no ABRManager.
   * @private
   * @type {Object|null}
   */
  private _priv_abrManager : ABRManager|null;

  /**
   * Manifest linked to the current content.
   * Null if no content has been loaded or if the current content loaded
   * has no manifest.
   * @private
   * @type {Object|null}
   */
  private _priv_currentManifest : Manifest|null;

  /**
   * Events memory, to avoid re-triggering the same event twice.
   * @private
   * @type {Object}
   */
  private _priv_recordedEvents : IDictionary<any>; // TODO?

  /**
   * Current fatal error which STOPPED the player.
   * Null when the player is not STOPPED anymore or if STOPPED but not due to
   * an error.
   * @private
   * @type {Error|null}
   */
  private _priv_fatalError : Error|null;

  /**
   * Current Image Track Data associated to the content.
   * Null if no content has been loaded or if the current content has no
   * image playlist linked to it.
   * @private
   * @type {Object|null}
   */
  private _priv_currentImagePlaylist : IBifThumbnail[]|null;

  /**
   * @returns {Object}
   */
  static get ErrorTypes() : IDictionary<string> {
    return ErrorTypes;
  }

  /**
   * @returns {Object}
   */
  static get ErrorCodes() : IDictionary<string> {
    return ErrorCodes;
  }

  /**
   * @returns {string} - current log level
   */
  static get LogLevel() : string {
    return log.getLevel();
  }

  /**
   * @param {string} logLevel - should be either (by verbosity ascending):
   *   - "NONE"
   *   - "ERROR"
   *   - "WARNING"
   *   - "INFO"
   *   - "DEBUG"
   * Any other value will be translated to "NONE".
   */
  static set LogLevel(logLevel : string) {
    log.setLevel(logLevel);
  }

  /**
   * Note: as the private state from this class can be pretty heavy, every
   * private properties should be initialized here for better visibility.
   * @constructor
   * @param {Object} options
   * @param {HTMLMediaElement} options.videoElement
   */
  constructor(options : IConstructorOptions = {}) {
    super();
    const {
      initialAudioBitrate,
      initialVideoBitrate,
      limitVideoWidth,
      maxAudioBitrate,
      maxBufferAhead,
      maxBufferBehind,
      maxVideoBitrate,
      throttleWhenHidden,
      videoElement,
      wantedBufferAhead,
    } = parseConstructorOptions(options);

    // Workaround to support Firefox autoplay on FF 42.
    // See: https://bugzilla.mozilla.org/show_bug.cgi?id=1194624
    videoElement.preload = "auto";

    this.version = /*PLAYER_VERSION*/"3.0.4";
    this.log = log;
    this.state = "STOPPED";
    this.videoElement = videoElement;

    this._priv_destroy$ = new Subject();

    onFullscreenChange$(videoElement)
      .takeUntil(this._priv_destroy$)
      .subscribe(() => this.trigger("fullscreenChange", this.isFullscreen()));

    onTextTrackChanges$(videoElement.textTracks)
      .takeUntil(this._priv_destroy$)
      .map((evt : Event) => { // prepare TextTrack array
        const target = evt.target as TextTrackList;
        const arr : TextTrack[] = [];
        for (let i = 0; i < target.length; i++) {
          const textTrack = target[i];
          arr.push(textTrack);
        }
        return arr;
      })

      // We can have two consecutive textTrackChanges with the exact same
      // payload when we perform multiple texttrack operations before the event
      // loop is freed.
      // In that case we only want to fire one time the observable.
      .distinctUntilChanged((
        textTracksA : TextTrack[],
        textTracksB : TextTrack[]
      ) => {
        if (textTracksA.length !== textTracksB.length) {
          return false;
        }
        for (let i = 0; i < textTracksA.length; i++) {
          if (textTracksA[i] !== textTracksB[i]) {
            return false;
          }
        }
        return true;
      })
      .subscribe((x : TextTrack[]) => this._priv_onNativeTextTracksNext(x));

    this._priv_errorStream$ = new Subject();
    this._priv_playing$ = new ReplaySubject(1);
    this._priv_speed$ = new BehaviorSubject(videoElement.playbackRate);
    this._priv_unsubscribeLoadedVideo$ = new Subject();
    this._priv_streamLock$ = new BehaviorSubject(false);
    this._priv_wantedBufferAhead$ = new BehaviorSubject(wantedBufferAhead);
    this._priv_maxBufferAhead$ = new BehaviorSubject(maxBufferAhead);
    this._priv_maxBufferBehind$ = new BehaviorSubject(maxBufferBehind);
    this._priv_lastBitrates = {
      audio: initialAudioBitrate,
      video: initialVideoBitrate,
    };
    this._priv_initialMaxAutoBitrates = {
      audio: maxAudioBitrate,
      video: maxVideoBitrate,
    };
    this._priv_manualBitrates = {
      audio: -1,
      video: -1,
    };
    this._priv_throttleWhenHidden = throttleWhenHidden;
    this._priv_limitVideoWidth = limitVideoWidth;
    this._priv_mutedMemory = DEFAULT_UNMUTED_VOLUME;

    this._priv_initialAudioTrack = undefined;
    this._priv_initialTextTrack = undefined;
    this._priv_languageManager = null;
    this._priv_abrManager = null;

    this._priv_currentManifest = null;
    this._priv_activeRepresentations = null;
    this._priv_activeAdaptations = null;
    this._priv_activePeriods = null;

    this._priv_recordedEvents = {}; // event memory

    this._priv_fatalError = null;
    this._priv_currentImagePlaylist = null;

    this._priv_setPlayerState(PLAYER_STATES.STOPPED);
  }

  /**
   * Stop the player.
   */
  stop() : void {
    if (this.state !== PLAYER_STATES.STOPPED) {
      this._priv_unsubscribeLoadedVideo$.next();
      this._priv_cleanUpCurrentContentState();
      this._priv_setPlayerState(PLAYER_STATES.STOPPED);
    }
  }

  /**
   * Free the resources used by the player.
   */
  dispose() : void {
    // free resources linked to the loaded content
    this.stop();

    // free resources used for EME management
    emeDispose();

    // free Observables linked to the Player instance
    this._priv_destroy$.next();
    this._priv_destroy$.complete();

    // Complete all subjects
    this._priv_unsubscribeLoadedVideo$.complete();
    this._priv_errorStream$.complete();
    this._priv_playing$.complete();
    this._priv_speed$.complete();
    this._priv_streamLock$.complete();
    this._priv_wantedBufferAhead$.complete();
    this._priv_maxBufferAhead$.complete();
    this._priv_maxBufferBehind$.complete();

    // un-attach video element
    this.videoElement = null;
  }

  /**
   * Load a new video.
   * @param {Object} opts
   * @returns {Observable}
   * @throws Error - throws if no url is given.
   * @throws Error - throws if no transport is given and no default transport
   * has been set.
   * @throws Error - throws if the asked transport does not exist
   */
  loadVideo(opts : ILoadVideoOptions) : void {
    const options = parseLoadVideoOptions(opts);
    log.info("loadvideo", options);

    const {
      autoPlay,
      defaultAudioTrack,
      defaultTextTrack,
      keySystems,
      startAt,
      supplementaryImageTracks,
      supplementaryTextTracks,
      transport,
      transportOptions,
      url,
    } = options;

    // Perform multiple checks on the given options
    if (!this.videoElement) {
      throw new Error("the attached video element is disposed");
    }

    const transportFn = Transports[transport];
    if (!transportFn) {
      throw new Error(`transport "${transport}" not supported`);
    }

    const transportObj = transportFn(transportOptions);

    // now that every check has passed, stop previous content
    this.stop();

    // prepare initial tracks played
    this._priv_initialAudioTrack = defaultAudioTrack;
    this._priv_initialTextTrack = defaultTextTrack;

    // inilialize to false
    this._priv_playing$.next(false);

    // get every properties used from context for clarity
    const videoElement = this.videoElement;

    // TODO either ditch or repair directFile playback
    /** @type {Boolean} */
    // const withMediaSource = !transport.directFile;
    const withMediaSource = true;

    /**
     * Global clock used for the whole application.
     * @type {Observable.<Object>}
     */
    const clock$ = createClock(videoElement, { withMediaSource });

    /**
     * Options used by the ABR Manager.
     * @type {Object}
     */
    const adaptiveOptions = {
      initialBitrates: this._priv_lastBitrates,
      manualBitrates: this._priv_manualBitrates,
      maxAutoBitrates: this._priv_initialMaxAutoBitrates,
      throttle: this._priv_throttleWhenHidden ? {
        video: isInBackground$()
          .map(isBg => isBg ? 0 : Infinity)
          .takeUntil(this._priv_unsubscribeLoadedVideo$),
      } : {},
      limitWidth: this._priv_limitVideoWidth ? {
        video: videoWidth$(videoElement)
          .takeUntil(this._priv_unsubscribeLoadedVideo$),
      } : {},
    };

    /**
     * Options used by the Buffer(s)
     * @type {Object}
     */
    const bufferOptions = {
      wantedBufferAhead$: this._priv_wantedBufferAhead$,
      maxBufferAhead$: this._priv_maxBufferAhead$,
      maxBufferBehind$: this._priv_maxBufferBehind$,
    };

    /**
     * Options used by the TextTrack SourceBuffer
     * @type {Object}
     */
    const textTrackOptions = options.textTrackMode === "native" ? {
      textTrackMode: "native" as "native",
      hideNativeSubtitle: options.hideNativeSubtitle,
    } : {
      textTrackMode: "html" as "html",
      textTrackElement: options.textTrackElement,
    };

    /**
     * Stream Observable, through which the content will be launched.
     * @type {Observable.<Object>}
     */
    const stream = Stream({
      adaptiveOptions,
      autoPlay,
      bufferOptions,
      errorStream: this._priv_errorStream$,
      keySystems,
      speed$: this._priv_speed$,
      startAt,
      textTrackOptions,
      timings$: clock$,
      transport: transportObj,
      url,
      videoElement,
      withMediaSource,

      supplementaryImageTracks,
      supplementaryTextTracks,
    })
      .takeUntil(this._priv_unsubscribeLoadedVideo$)
      .publish();

    /**
     * Emit a truthy value when the player stalls, a falsy value as it unstalls.
     * TODO Find a way with TS
     * @type {Observable}
     */
    const stalled$ = stream
      .filter(({ type }) => type === "stalled")
      .map(x => x.value)
      .startWith(null) as Observable<null|{ state : string}> ;

    /**
     * Emit when the stream is considered "loaded".
     * @type {Observable}
     */
    const loaded = stream
      .filter(({ type }) => type === "loaded")
      .take(1)
      .share();

    /**
     * Emit the player state as it changes.
     * TODO only way to call setPlayerState?
     * @type {Observable.<string>}
     */
    const stateChanges$ = loaded.mapTo(PLAYER_STATES.LOADED)
      .concat(
        Observable.combineLatest(this._priv_playing$, stalled$)
          .takeUntil(this._priv_unsubscribeLoadedVideo$)
          .map(([isPlaying, stalledStatus]) => {
            if (stalledStatus) {
              return (stalledStatus.state === "seeking") ?
                PLAYER_STATES.SEEKING : PLAYER_STATES.BUFFERING;
            }
            return isPlaying ? PLAYER_STATES.PLAYING : PLAYER_STATES.PAUSED;
          })

          // begin emitting those only when the content start to play
          .skipUntil(
            this._priv_playing$.filter(isPlaying => isPlaying)
          )
      )
      .distinctUntilChanged()
      .startWith(PLAYER_STATES.LOADING);

    /**
     * Emit true each time the player goes into a "play" state.
     * @type {Observable.<Boolean>}
     */
    const videoPlays$ = onPlayPause$(videoElement)
      .map(evt => evt.type === "play");

    let streamDisposable : Subscription|undefined;
    this._priv_unsubscribeLoadedVideo$.take(1).subscribe(() => {
      if (streamDisposable) {
        streamDisposable.unsubscribe();
      }
    });

    videoPlays$
      .takeUntil(this._priv_unsubscribeLoadedVideo$)
      .subscribe(x => this._priv_onPlayPauseNext(x), noop);

    clock$
      .takeUntil(this._priv_unsubscribeLoadedVideo$)
      .subscribe(x => this._priv_triggerTimeChange(x), noop);

    stateChanges$
      .takeUntil(this._priv_unsubscribeLoadedVideo$)
      .subscribe(x => this._priv_setPlayerState(x), noop);

    stream.subscribe(
      (x) => this._priv_onStreamNext(x),
      (err : Error) => this._priv_onStreamError(err),
      () => this._priv_onStreamComplete()
    );

    this._priv_errorStream$
      .takeUntil(this._priv_unsubscribeLoadedVideo$)
      .subscribe(
        x => this._priv_onErrorStreamNext(x)
      );

    // connect the stream when the lock is inactive
    this._priv_streamLock$
      .filter((isLocked) => !isLocked)
      .take(1)
      .takeUntil(this._priv_unsubscribeLoadedVideo$)
      .subscribe(() => {
        streamDisposable = stream.connect();
      });
  }

  /**
   * Returns fatal error if one for the current content. null otherwise.
   * @returns {Object|null}
   */
  getError() : Error|null {
    return this._priv_fatalError;
  }

  /**
   * Returns manifest/playlist object.
   * null if the player is STOPPED.
   * @returns {Manifest|null}
   */
  getManifest() : Manifest|null {
    return this._priv_currentManifest || null;
  }

  // XXX TODO Private for debugging
  // getActivePeriods() : Period[] {
  //   if (!this._priv_activePeriods) {
  //     return [];
  //   }
  //   return this._priv_activePeriods.unwrap();
  // }

  // getActiveAdaptations() {
  //   return this._priv_activeAdaptations;
  // }

  // getActiveRepresentations() {
  //   return this._priv_activeRepresentations;
  // }

  /**
   * Returns the current Period.
   * @returns {Object|null}
   */
  getCurrentPeriod() : Period|null {
    if (!this._priv_activePeriods) {
      return null;
    }
    return this._priv_activePeriods.head() || null;
  }

  /**
   * Returns adaptations (tracks) for every currently playing type
   * (audio/video/text...).
   * @returns {Object|null}
   */
  getCurrentAdaptations() {
    const currentPeriod = this.getCurrentPeriod();
    if (!currentPeriod || !this._priv_activeAdaptations){
      return null;
    }
    return this._priv_activeAdaptations.get(currentPeriod) || null;
  }

  /**
   * Returns representations (qualities) for every currently playing type
   * (audio/video/text...).
   * @returns {Object|null}
   */
  getCurrentRepresentations() {
    const currentPeriod = this.getCurrentPeriod();
    if (!currentPeriod || !this._priv_activeRepresentations){
      return null;
    }
    return this._priv_activeRepresentations.get(currentPeriod) || null;
  }

  /**
   * Returns the video DOM element used by the player.
   * You should not its HTML5 API directly and use the player's method instead,
   * to ensure a well-behaved player.
   * @returns {HTMLMediaElement|null}
   */
  getVideoElement() : HTMLMediaElement|null {
    return this.videoElement;
  }

  /**
   * Returns the text-track element used by the player to inject subtitles.
   * @returns {TextTrack}
   */
  getNativeTextTrack() : TextTrack|null {
    if (!this.videoElement) {
      throw new Error("Disposed player");
    }
    const videoElement = this.videoElement;
    const textTracks = videoElement.textTracks;
    if (textTracks.length > 0) {
      return videoElement.textTracks[0];
    } else {
      return null;
    }
  }

  /**
   * Returns the player's current state.
   * @returns {string}
   */
  getPlayerState() : string|undefined {
    return this.state;
  }

  /**
   * Returns true if:
   *   - a content is loaded
   *   - the content is a live content
   * @returns {Boolean}
   */
  isLive() : boolean {
    if (!this._priv_currentManifest) {
      return false;
    }
    return this._priv_currentManifest.isLive;
  }

  /**
   * Returns the url of the content's manifest
   * @returns {string|undefined}
   */
  getUrl() : string|undefined {
    if (!this._priv_currentManifest) {
      return undefined;
    }
    return this._priv_currentManifest.getUrl();
  }

  /**
   * Returns the video duration, in seconds.
   * NaN if no video is playing.
   * @returns {Number}
   */
  getVideoDuration() : number {
    if (!this.videoElement) {
      throw new Error("Disposed player");
    }
    return this.videoElement.duration;
  }

  /**
   * Returns in seconds the difference between:
   *   - the end of the current contiguous loaded range.
   *   - the current time
   * @returns {Number}
   */
  getVideoBufferGap() : number {
    if (!this.videoElement) {
      throw new Error("Disposed player");
    }
    const videoElement = this.videoElement;
    return getLeftSizeOfRange(videoElement.buffered, videoElement.currentTime);
  }

  /**
   * Returns in seconds the difference between:
   *   - the end of the current contiguous loaded range.
   *   - the start of the current contiguous loaded range.
   * @returns {Number}
   */
  getVideoLoadedTime() : number {
    if (!this.videoElement) {
      throw new Error("Disposed player");
    }
    const videoElement = this.videoElement;
    return getSizeOfRange(videoElement.buffered, videoElement.currentTime);
  }

  /**
   * Returns in seconds the difference between:
   *   - the current time.
   *   - the start of the current contiguous loaded range.
   * @returns {Number}
   */
  getVideoPlayedTime() : number {
    if (!this.videoElement) {
      throw new Error("Disposed player");
    }
    const videoElement = this.videoElement;
    return getPlayedSizeOfRange(videoElement.buffered, videoElement.currentTime);
  }

  /**
   * Get the current position, in s, in wall-clock time.
   * That is:
   *   - for live content, get a timestamp, in s, of the current played content.
   *   - for static content, returns the position from beginning in s.
   *
   * If you do not know if you want to use this method or getPosition:
   *   - If what you want is to display the current time to the user, use this
   *     one.
   *   - If what you want is to interact with the player's API or perform other
   *     actions (like statistics) with the real player data, use getPosition.
   *
   * @returns {Number}
   */
  getWallClockTime() : number {
    if (!this.videoElement) {
      throw new Error("Disposed player");
    }
    if (!this._priv_currentManifest) {
      return 0;
    }
    const ct = this.videoElement.currentTime;
    return this.isLive() ?
      (+toWallClockTime(ct, this._priv_currentManifest) / 1000) : ct;
  }

  /**
   * Get the current position, in seconds, of the video element.
   *
   * If you do not know if you want to use this method or getWallClockTime:
   *   - If what you want is to display the current time to the user, use
   *     getWallClockTime.
   *   - If what you want is to interact with the player's API or perform other
   *     actions (like statistics) with the real player data, use this one.
   *
   * @returns {Number}
   */
  getPosition() : number {
    if (!this.videoElement) {
      throw new Error("Disposed player");
    }
    return this.videoElement.currentTime;
  }

  /**
   * Returns the current speed at which the video plays.
   * @returns {Number}
   */
  getPlaybackRate() : number {
    return this._priv_speed$.getValue();
  }

  /**
   * @returns {Number}
   */
  getVolume() : number {
    if (!this.videoElement) {
      throw new Error("Disposed player");
    }
    return this.videoElement.volume;
  }

  /**
   * @returns {Boolean}
   */
  isFullscreen() : boolean {
    return isFullscreen();
  }

  /**
   * @returns {Array.<Number>}
   */
  getAvailableVideoBitrates() : number[] {
    const currentPeriod = this.getCurrentPeriod();
    if (!currentPeriod || !this._priv_activeAdaptations){
      return [];
    }
    const adaptations = this._priv_activeAdaptations.get(currentPeriod);
    const videoAdaptation = adaptations && adaptations.video;
    if (!videoAdaptation) {
      return [];
    }

    return videoAdaptation.representations
      .map(({ bitrate }) => bitrate);
  }

  /**
   * @returns {Array.<Number>}
   */
  getAvailableAudioBitrates() : number[] {
    const currentPeriod = this.getCurrentPeriod();
    if (!currentPeriod || !this._priv_activeAdaptations){
      return [];
    }
    const adaptations = this._priv_activeAdaptations.get(currentPeriod);
    const audioAdaptation = adaptations && adaptations.audio;
    if (!audioAdaptation) {
      return [];
    }

    return audioAdaptation.representations
      .map(({ bitrate }) => bitrate);
  }

  /**
   * Returns the manual audio bitrate set. -1 if in AUTO mode.
   * @returns {Number}
   */
  getManualAudioBitrate() : number {
    return this._priv_manualBitrates.audio;
  }

  /**
   * Returns the manual video bitrate set. -1 if in AUTO mode.
   * @returns {Number}
   */
  getManualVideoBitrate() : number {
    return this._priv_manualBitrates.video;
  }

  /**
   * Returns currently considered bitrate for video segments.
   * @returns {Number|undefined}
   */
  getVideoBitrate() : number|undefined {
    return this._priv_recordedEvents.videoBitrate;
  }

  /**
   * Returns currently considered bitrate for audio segments.
   * @returns {Number|undefined}
   */
  getAudioBitrate() : number|undefined {
    return this._priv_recordedEvents.audioBitrate;
  }

  /**
   * Returns max wanted video bitrate currently set.
   * @returns {Number}
   */
  getMaxVideoBitrate() : number|undefined {
    if (!this._priv_abrManager) {
      return this._priv_initialMaxAutoBitrates.video;
    }
    return this._priv_abrManager.getMaxAutoBitrate("video");
  }

  /**
   * Returns max wanted audio bitrate currently set.
   * @returns {Number}
   */
  getMaxAudioBitrate() : number|undefined {
    if (!this._priv_abrManager) {
      return this._priv_initialMaxAutoBitrates.audio;
    }
    return this._priv_abrManager.getMaxAutoBitrate("audio");
  }

  /**
   * Play/Resume the current video.
   */
  play() : void {
    if (!this.videoElement) {
      throw new Error("Disposed player");
    }
    /* tslint:disable no-floating-promises */
    this.videoElement.play();
    /* tslint:enable no-floating-promises */
  }

  /**
   * Pause playback of the video.
   */
  pause() : void {
    if (!this.videoElement) {
      throw new Error("Disposed player");
    }
    this.videoElement.pause();
  }

  /**
   * Update the playback rate of the video.
   * @param {Number} rate
   */
  setPlaybackRate(rate : number) : void {
    this._priv_speed$.next(rate);
  }

  /**
   * Seek to a given absolute position.
   * @param {Number|Object} time
   * @returns {Number} - The time the player has seek to
   */
  seekTo(
    time : number | { relative : number } | { position : number } |
    { wallClockTime : number }
  ) : number {
    if (!this._priv_currentManifest) {
      throw new Error("player: no manifest loaded");
    }
    if (!this.videoElement) {
      throw new Error("Disposed player");
    }

    let positionWanted : number|undefined;
    const typeOf = typeof time;

    if (typeOf === "number") {
      positionWanted = time as number;
    } else if (typeOf === "object") {
      const currentTs = this.videoElement.currentTime;
      if ((time as { relative? : number }).relative != null) {
        positionWanted = currentTs + (time as { relative : number }).relative;
      } else if ((time as { position? : number }).position != null) {
        positionWanted = (time as { position : number }).position;
      } else if ((time as { wallClockTime? : number }).wallClockTime != null) {
        const manifest = this._priv_currentManifest;
        positionWanted = fromWallClockTime(
          (time as { wallClockTime : number }).wallClockTime * 1000,
          manifest
        );
      } else {
        throw new Error("invalid time object. You must set one of the " +
          "following properties: \"relative\", \"position\" or " +
          "\"wallClockTime\"");
      }
    }

    if (positionWanted === undefined) {
      throw new Error("invalid time given");
    }
    this.videoElement.currentTime = positionWanted;
    return positionWanted;
  }

  exitFullscreen() : void {
    exitFullscreen();
  }

  /**
   * Set/exit fullScreen.
   * @param {Boolean} [goFull=true] - if false, exit full screen.
   */
  setFullscreen(goFull : boolean = true) : void {
    if (!this.videoElement) {
      throw new Error("Disposed player");
    }
    if (goFull) {
      requestFullscreen(this.videoElement);
    } else {
      exitFullscreen();
    }
  }

  /**
   * Set the player's volume. From 0 (muted volume) to 1 (maximum volume).
   * @param {Number}
   */
  setVolume(volume : number) : void {
    if (!this.videoElement) {
      throw new Error("Disposed player");
    }
    const videoElement = this.videoElement;
    if (volume !== videoElement.volume) {
      videoElement.volume = volume;
      this.trigger("volumeChange", volume);
    }
  }

  /**
   * Returns true if the volume is set to 0. false otherwise.
   * @returns {Boolean}
   */
  isMute() : boolean {
    return !this.getVolume();
  }

  /**
   * Set the volume to 0 and save current one for when unmuted.
   */
  mute() : void {
    this._priv_mutedMemory = this.getVolume();
    this.setVolume(0);
  }

  /**
   * Set the volume back to when it was when mute was last called.
   * If the volume was set to 0, set a default volume instead (see config).
   */
  unMute() : void {
    const vol = this.getVolume();
    if (vol === 0) {
      this.setVolume(this._priv_mutedMemory || DEFAULT_UNMUTED_VOLUME);
    }
  }

  /**
   * Force the video bitrate to a given value. Act as a ceil.
   * -1 to set it on AUTO Mode
   * @param {Number} btr
   */
  setVideoBitrate(btr : number) : void {
    this._priv_manualBitrates.video = btr;
    if (this._priv_abrManager) {
      this._priv_abrManager.setManualBitrate("video", btr);
    }
  }

  /**
   * Force the audio bitrate to a given value. Act as a ceil.
   * -1 to set it on AUTO Mode
   * @param {Number} btr
   */
  setAudioBitrate(btr : number) : void {
    this._priv_manualBitrates.audio = btr;
    if (this._priv_abrManager) {
      this._priv_abrManager.setManualBitrate("audio", btr);
    }
  }

  /**
   * Update the maximum video bitrate the user can switch to.
   * @param {Number} btr
   */
  setMaxVideoBitrate(btr : number) : void {
    // set it for the next content loaded
    this._priv_initialMaxAutoBitrates.video = btr;

    // set it for the current if one is loaded
    if (this._priv_abrManager) {
      this._priv_abrManager.setMaxAutoBitrate("video", btr);
    }
  }

  /**
   * Update the maximum video bitrate the user can switch to.
   * @param {Number} btr
   */
  setMaxAudioBitrate(btr : number) : void {
    // set it for the next content loaded
    this._priv_initialMaxAutoBitrates.audio = btr;

    // set it for the current if one is loaded
    if (this._priv_abrManager) {
      this._priv_abrManager.setMaxAutoBitrate("audio", btr);
    }
  }

  /**
   * Set the max buffer size for the buffer behind the current position.
   * Every buffer data before will be removed.
   * @param {Number} depthInSeconds
   */
  setMaxBufferBehind(depthInSeconds : number) : void {
    this._priv_maxBufferBehind$.next(depthInSeconds);
  }

  /**
   * Set the max buffer size for the buffer behind the current position.
   * Every buffer data before will be removed.
   * @param {Number} depthInSeconds
   */
  setMaxBufferAhead(depthInSeconds : number) : void {
    this._priv_maxBufferAhead$.next(depthInSeconds);
  }

  /**
   * Set the max buffer size for the buffer ahead of the current position.
   * The player will stop downloading chunks when this size is reached.
   * @param {Number} sizeInSeconds
   */
  setWantedBufferAhead(sizeInSeconds : number) : void {
    this._priv_wantedBufferAhead$.next(sizeInSeconds);
  }

  /**
   * Returns the max buffer size for the buffer behind the current position.
   * @returns {Number}
   */
  getMaxBufferBehind() : number {
    return this._priv_maxBufferBehind$.getValue();
  }

  /**
   * Returns the max buffer size for the buffer behind the current position.
   * @returns {Number}
   */
  getMaxBufferAhead() : number {
    return this._priv_maxBufferAhead$.getValue();
  }

  /**
   * Returns the max buffer size for the buffer ahead of the current position.
   * @returns {Number}
   */
  getWantedBufferAhead() : number {
    return this._priv_wantedBufferAhead$.getValue();
  }

  /**
   * Returns type of current keysystem (e.g. playready, widevine) if the content
   * is encrypted. null otherwise.
   * @returns {string|null}
   */
  getCurrentKeySystem() : string|null {
    return getCurrentKeySystem();
  }

  /**
   * Returns every available audio tracks for the current Period.
   * @returns {Array.<Object>|null}
   */
  getAvailableAudioTracks() : ILMAudioTrackList | null {
    if (!this._priv_languageManager) {
      return null;
    }
    return this._priv_languageManager.getAvailableAudioTracks();
  }

  /**
   * Returns every available text tracks for the current Period.
   * @returns {Array.<Object>|null}
   */
  getAvailableTextTracks() : ILMTextTrackList | null {
    if (!this._priv_languageManager) {
      return null;
    }
    return this._priv_languageManager.getAvailableTextTracks();
  }

  /**
   * Returns currently chosen audio language for the current Period.
   * @returns {string}
   */
  getAudioTrack() : ILMAudioTrack|null|undefined {
    if (!this._priv_languageManager) {
      return undefined;
    }
    return this._priv_languageManager.getChosenAudioTrack();
  }

  /**
   * Returns currently chosen subtitle for the current Period.
   * @returns {string}
   */
  getTextTrack() : ILMTextTrack|null|undefined {
    if (!this._priv_languageManager) {
      return undefined;
    }
    return this._priv_languageManager.getChosenTextTrack();
  }

  /**
   * Update the audio language for the current Period.
   * @param {string} audioId
   * @throws Error - the current content has no LanguageManager.
   * @throws Error - the given id is linked to no audio track.
   */
  setAudioTrack(audioId : string|number) : void {
    if (!this._priv_languageManager) {
      throw new Error("No compatible content launched.");
    }
    try {
      this._priv_languageManager.setAudioTrackByID(audioId);
    }
    catch (e) {
      throw new Error("player: unknown audio track");
    }
  }

  /**
   * Update the text language for the current Period.
   * @param {string} sub
   * @throws Error - the current content has no LanguageManager.
   * @throws Error - the given id is linked to no text track.
   */
  setTextTrack(textId : string|number) : void {
    if (!this._priv_languageManager) {
      throw new Error("No compatible content launched.");
    }
    try {
      this._priv_languageManager.setTextTrackByID(textId);
    }
    catch (e) {
      throw new Error("player: unknown text track");
    }
  }

  /**
   * Disable subtitles for the current content.
   */
  disableTextTrack() : void {
    if (!this._priv_languageManager) {
      return;
    }
    return this._priv_languageManager.disableTextTrack();
  }

  /**
   * @returns {Array.<Object>|null}
   */
  getImageTrackData() : IBifThumbnail[] | null {
    if (!this._priv_currentManifest) {
      return null;
    }
    return this._priv_currentImagePlaylist;
  }

  /**
   * Get minimum seek-able position.
   * @returns {number}
   */
  getMinimumPosition() : number|null {
    if (!this._priv_currentManifest) {
      return null;
    }
    return getMinimumBufferPosition(this._priv_currentManifest);
  }

  /**
   * Get maximum seek-able position.
   * @returns {number}
   */
  getMaximumPosition() : number|null {
    if (!this._priv_currentManifest) {
      return null;
    }
    return getMaximumBufferPosition(this._priv_currentManifest);
  }

  /**
   * Reset all state properties relative to a playing content.
   */
  private _priv_cleanUpCurrentContentState() : void {
    // lock creation of new streams while cleaning up is pending
    this._priv_streamLock$.next(true);

    // language management
    this._priv_initialAudioTrack = undefined;
    this._priv_initialTextTrack = undefined;
    this._priv_languageManager = null;

    // ABR management
    if (this._priv_abrManager) {
      this._priv_abrManager.dispose();
      this._priv_abrManager = null;
    }

    // manifest
    this._priv_activeRepresentations = null;
    this._priv_activeAdaptations = null;
    this._priv_activePeriods = null;
    this._priv_currentManifest = null;

    // event memory
    this._priv_recordedEvents = {};

    // misc
    this._priv_fatalError = null;
    this._priv_currentImagePlaylist = null;

    // EME cleaning
    const freeUpStreamLock = () => {
      this._priv_streamLock$.next(false);
    };

    clearEME()
      .catch(() => Observable.empty())
      .subscribe(noop, freeUpStreamLock, freeUpStreamLock);
  }

  /**
   * Store and emit new player state (e.g. text track, videoBitrate...).
   * We check for deep equality to avoid emitting 2 consecutive times the same
   * state.
   * @param {string} type - the type of the updated state (videoBitrate...)
   * @param {*} value - its new value
   */
  private _priv_recordState(type : string, value : any) : void {
    const prev = this._priv_recordedEvents[type];
    if (!deepEqual(prev, value)) {
      this._priv_recordedEvents[type] = value;
      this.trigger(`${type}Change`, value);
    }
  }

  /**
   * Called each time the Stream Observable emits.
   * @param {Object} streamInfos - payload emitted
   */
  private _priv_onStreamNext(streamInfos : IStreamEvent) : void {
    switch (streamInfos.type) {
      case "periodReady":
        this._priv_onPeriodReady(streamInfos.value);
        break;
      case "finishedPeriod":
        this._priv_onFinishedPeriod(streamInfos.value);
        break;
      case "representationChange":
        this._priv_onRepresentationChange(streamInfos.value);
        break;
      case "adaptationChange":
        this._priv_onAdaptationChange(streamInfos.value);
        break;
      case "manifestUpdate":
        this._priv_onManifestUpdate(streamInfos.value);
        break;
      case "bitrateEstimationChange":
        this._priv_onBitrateEstimationChange(streamInfos.value);
        break;
      case "started":
        this._priv_onStreamStarted(streamInfos.value);
        break;
      case "added-segment":
        const { bufferType, parsed } = streamInfos.value;
        if (bufferType === "image") {
          const segmentData = parsed.segmentData;

          // TODO merge multiple data from the same track together
          this._priv_currentImagePlaylist = segmentData as IBifThumbnail[];
          this.trigger("imageTrackUpdate", {
            data: this._priv_currentImagePlaylist,
          });
        }
    }
  }

  /**
   * Called each time the Stream emits through its errorStream (non-fatal
   * errors).
   * @param {Object} streamInfos
   */
  private _priv_onErrorStreamNext(error : Error) : void {
    this.trigger("warning", error);
  }

  /**
   * Called when the Stream instance throws (fatal errors).
   * @param {Object} streamInfos
   */
  private _priv_onStreamError(error : Error) : void {
    this._priv_unsubscribeLoadedVideo$.next();
    this._priv_cleanUpCurrentContentState();
    this._priv_fatalError = error;
    this._priv_setPlayerState(PLAYER_STATES.STOPPED);

    // TODO This condition is here because the eventual callback called when the
    // player state is updated can launch a new content, thus the error will not
    // be here anymore, in which case triggering the "error" event is unwanted.
    // This is not perfect however as technically, this condition could be true
    // even for a new content (I cannot see it happen with the current code but
    // that's not a reason). In that case, "error" would be triggered 2 times.
    // Find a better solution.
    if (this._priv_fatalError === error) {
      this.trigger("error", error);
    }
  }

  /**
   * Called when the Stream instance complete.
   * @param {Object} streamInfos
   */
  private _priv_onStreamComplete() : void {
    this._priv_unsubscribeLoadedVideo$.next();
    this._priv_cleanUpCurrentContentState();
    this._priv_setPlayerState(PLAYER_STATES.ENDED);
  }

  /**
   * Called when the stream starts.
   * @param {Object} value
   * @param {Manifest} value.manifest - The Manifest instance
   * @param {Object} abrManager - ABR manager which can be used to select the
   * wanted bandwidth.
   */
  private _priv_onStreamStarted(value : {
    abrManager : ABRManager;
    manifest : Manifest;
  }) : void {
    const { manifest, abrManager } = value;
    this._priv_currentManifest = manifest;
    this._priv_abrManager = abrManager;

    this._priv_languageManager = new LanguageManager({
      preferredAudioTracks: this._priv_initialAudioTrack === undefined ?
        undefined : [this._priv_initialAudioTrack],
      preferredTextTracks: this._priv_initialTextTrack === undefined ?
        undefined : [this._priv_initialTextTrack],
    });
    this.trigger("manifestChange", manifest);
  }

  /**
   * Triggered each times the stream "prepares" a new Period, and
   * needs the API to sent it its chosen adaptation.
   * @param {Object} value
   * @param {Object} value.period
   * @param {Object} value.adaptations
   * XXX TODO
   */
  private _priv_onPeriodReady(value : {
    type : SupportedBufferTypes;
    period : Period;
    adaptation$ : Subject<Adaptation|null>;
  }) : void {
    const { type, period, adaptation$ } = value;

    if (!this._priv_activePeriods) {
      this._priv_activePeriods = new SortedList<Period>((a, b) => a.start - b.start);
    }
    this._priv_activePeriods.add(period);

    if ((type === "audio" || type === "text")) {
      if (!this._priv_languageManager) {
        log.error(`LanguageManager not instanciated for a new ${type} period`);
        adaptation$.next(null);
      } else {
        this._priv_languageManager.addPeriod(type, period, adaptation$);
      }
    } else {
      const adaptations = period.adaptations[type];
      if (adaptations && adaptations.length) {
        adaptation$.next(adaptations[0]);
      } else {
        adaptation$.next(null);
      }
    }
  }

  private _priv_onFinishedPeriod(value : {
    type : SupportedBufferTypes;
    period : Period;
  }) : void {
    const { type, period } = value;

    if (!this._priv_activePeriods) {
      log.error("API: No active period yet finishedPeriod event received.");
    } else {
      this._priv_activePeriods.removeFirst(period);
    }

    if (type === "audio" || type === "text") {
      if (this._priv_languageManager) {
        this._priv_languageManager.removePeriod(type, period);
      }
    }
  }

  private _priv_onManifestUpdate(value : { manifest : Manifest }) : void {
    if (__DEV__) {
      assert(value && value.manifest, "no manifest received");
    }

    const { manifest } = value;
    this._priv_currentManifest = manifest;

    if (this._priv_languageManager) {
      this._priv_languageManager.update();
    }

    this.trigger("manifestUpdate", manifest);
  }

  /**
   * @param {Object} obj
   * @param {string} obj.type
   * @param {Object} obj.adaptation
   */
  private _priv_onAdaptationChange({
    type,
    adaptation,
    period,
  } : {
    type : SupportedBufferTypes;
    adaptation : Adaptation|null;
    period : Period;
  }) : void {
    if (!this._priv_activeAdaptations) {
      this._priv_activeAdaptations = new Map();
    }

    const activeAdaptations = this._priv_activeAdaptations.get(period);
    if (!activeAdaptations) {
      this._priv_activeAdaptations.set(period, { [type]: adaptation });
    } else {
      activeAdaptations[type] = adaptation;
    }

    if (!this._priv_languageManager) {
      return;
    }

    // XXX TODO only for active period + new event on period change?
    if (type === "audio") {
      const audioTrack = this._priv_languageManager.getChosenAudioTrack();
      this._priv_recordState("audioTrack", audioTrack);
    } else if (type === "text") {
      const textTrack = this._priv_languageManager.getChosenTextTrack();
      this._priv_recordState("textTrack", textTrack);
    }
  }

  /**
   * Called each time a representation changes.
   * @param {Object} obj
   * @param {string} obj.type
   * @param {Object} obj.representation
   */
  private _priv_onRepresentationChange({
    type,
    period,
    representation,
  }: {
    type : SupportedBufferTypes;
    period : Period;
    representation : Representation|null;
  }) : void {
    if (!this._priv_activeRepresentations) {
      this._priv_activeRepresentations = new Map();
    }

    const activeRepresentations = this._priv_activeRepresentations.get(period);
    if (!activeRepresentations) {
      this._priv_activeRepresentations.set(period, { [type]: representation });
    } else {
      activeRepresentations[type] = representation;
    }

    const bitrate = representation && representation.bitrate;
    if (bitrate != null) {
      this._priv_lastBitrates[type] = bitrate;
    }

    // XXX TODO only for active period + new event on period change?
    if (type === "video") {
      this._priv_recordState("videoBitrate", bitrate != null ? bitrate : -1);
    } else if (type === "audio") {
      this._priv_recordState("audioBitrate", bitrate != null ? bitrate : -1);
    }
  }

  /**
   * @param {Object} obj
   * @param {string} type
   * @param {number|undefined} bitrate
   */
  private _priv_onBitrateEstimationChange({
    type,
    bitrate,
  } : {
    type : SupportedBufferTypes;
    bitrate : number|undefined;
  }) : void {
    if (__DEV__) {
      assert(type != null);
      assert(bitrate != null);
    }
    this._priv_recordState("bitrateEstimation", { type, bitrate });
  }

  /**
   * Called each time the player alternates between play and pause.
   * @param {Boolean} isPlaying
   */
  private _priv_onPlayPauseNext(isPlaying : boolean) : void {
    if (!this.videoElement) {
      throw new Error("Disposed player");
    }
    const videoElement = this.videoElement;
    if (!videoElement.ended) {
      this._priv_playing$.next(isPlaying);
    }
  }

  /**
   * Called each time a textTrack is added to the video DOM Element.
   * @param {Array.<TextTrackElement} tracks
   */
  private _priv_onNativeTextTracksNext(tracks : TextTrack[]) : void {
    this.trigger("nativeTextTracksChange", tracks);
  }

  /**
   * Called each time the player state updates.
   * @param {string} s
   */
  private _priv_setPlayerState(s : string) : void {
    if (this.state !== s) {
      this.state = s;
      log.info("playerStateChange", s);
      this.trigger("playerStateChange", s);
    }
  }

  /**
   * Called each time a new timing object is emitted.
   * @param {Object} timing
   */
  private _priv_triggerTimeChange(timing : IClockTick) : void {
    if (!this._priv_currentManifest || !timing) {
      return;
    }

    const positionData : IPositionUpdateItem = {
      position: timing.currentTime,
      duration: timing.duration,
      playbackRate: timing.playbackRate,

      // TODO fix higher up?
      bufferGap: isFinite(timing.bufferGap) ? timing.bufferGap : 0,
    };

    if (this._priv_currentManifest.isLive && timing.currentTime > 0) {
      positionData.wallClockTime =
        toWallClockTime(timing.currentTime, this._priv_currentManifest)
          .getTime() / 1000;
      positionData.liveGap =
        getMaximumBufferPosition(this._priv_currentManifest) - timing.currentTime;
    }

    this.trigger("positionUpdate", positionData);
  }
}

export default Player;
