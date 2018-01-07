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
 * This file is used to abstract the notion of text and audio language-switching
 * for an easier API management.
 */

import arrayFind = require("array-find");
import { Subject } from "rxjs/Subject";
import { Adaptation, Period } from "../../manifest";

import arrayIncludes from "../../utils/array-includes";
import log from "../../utils/log";
import SortedList from "../../utils/sorted_list";

export interface IAudioTrackConfiguration {
  language : string;
  normalized : string;
  audioDescription : boolean;
}
export interface ITextTrackConfiguration {
  language : string;
  normalized : string;
  closedCaption : boolean;
}
type IAudioTrackPreference = null | IAudioTrackConfiguration;
type ITextTrackPreference = null | ITextTrackConfiguration;

export interface ILMAudioTrack {
  language : string;
  normalized : string;
  audioDescription : boolean;
  id : number|string;
}
export interface ILMTextTrack {
  language : string;
  normalized : string;
  closedCaption : boolean;
  id : number|string;
}

export type ILMAudioTrackList = ILMAudioTrackListItem[];
export type ILMTextTrackList = ILMTextTrackListItem[];

export interface ILMAudioTrackListItem extends ILMAudioTrack {
  active : boolean;
}
export interface ILMTextTrackListItem extends ILMTextTrack {
  active : boolean;
}

interface ILMAudioInfos {
  adaptations : Adaptation[];
  adaptation$ : Subject<Adaptation|null> ;
  currentChoice? : Adaptation|null;
}

interface ILMTextInfos {
  adaptations : Adaptation[];
  adaptation$ : Subject<Adaptation|null> ;
  currentChoice? : Adaptation|null;
}

interface ILMPeriodItem {
  period : Period;
  audio? : ILMAudioInfos;
  text? : ILMTextInfos;
}

const PREFERENCES_MAX_LENGTH = 10;

/**
 * Manage audio and text tracks for all active periods.
 *
 * Most methods here allow to interact with the first chronologically added
 * Period.
 *
 * Languages for subsequent periods are also chosen accordingly.
 * @class LanguageManager
 */
export default class LanguageManager {
  private _periods : SortedList<ILMPeriodItem>;
  private _preferredAudioTracks : IAudioTrackPreference[];
  private _preferredTextTracks : ITextTrackPreference[];

  /**
   * @param {Object} defaults
   * @param {Array.<Object>} defaults.preferredAudioTracks
   * @param {Array.<Object>} defaults.preferredTextTracks
   */
  constructor(defaults : {
    preferredAudioTracks? : IAudioTrackPreference[];
    preferredTextTracks? : ITextTrackPreference[];
  } = {}) {
    const {
      preferredAudioTracks,
      preferredTextTracks,
    } = defaults;
    this._periods = new SortedList((a, b) => a.period.start - b.period.start);

    // TODO limit to PREFERENCES_MAX_LENGTH
    this._preferredAudioTracks = preferredAudioTracks || [];
    this._preferredTextTracks = preferredTextTracks || [];
  }

  addPeriod(
    bufferType : "audio" | "text",
    period : Period,
    adaptation$ : Subject<Adaptation|null>
  ) : void {
    const periodItem = getPeriodItem(this._periods, period);
    if (periodItem != null) {
      if (periodItem[bufferType] != null) {
        log.warn(`LanguageManager: ${bufferType} already added for period`, period);
        return;
      } else {
        periodItem[bufferType] = {
          adaptations: period.adaptations[bufferType] || [],
          adaptation$,
        };
        if (bufferType === "audio") {
          this._updateAudioTracks();
        } else if (bufferType === "text") {
          this._updateTextTracks();
        }
        return;
      }
    }

    this._periods.add({
      period,
      [bufferType]: {
        adaptations: period.adaptations[bufferType] || [],
        adaptation$,
      },
    });
    if (bufferType === "audio") {
      this._updateAudioTracks();
    } else if (bufferType === "text") {
      this._updateTextTracks();
    }
  }

  removePeriod(
    bufferType : "audio" | "text",
    period : Period
  ) : void {
    const periodIndex = findPeriodIndex(this._periods, period);
    if (periodIndex != null) {
      const periodItem = this._periods.get(periodIndex);
      if (periodItem[bufferType] == null) {
        log.warn(`LanguageManager: ${bufferType} already removed for period`, period);
        return;
      } else {
        delete periodItem[bufferType];
        if (periodItem.audio == null && periodItem.text == null) {
          this._periods.removeFirst(periodItem);
        }
        return;
      }
    }
    log.warn(`LanguageManager: ${bufferType} not found for period`, period);
  }

  update() {
    this._updateAudioTracks();
    this._updateTextTracks();
  }

  /**
   * Set audio track based on the ID of its adaptation for the first period.
   *
   * Set audio tracks for the next periods accordingly.
   * @param {string|Number} wantedId - adaptation id of the wanted track
   * @throws Error - Throws if the given id is not found in any audio adaptation
   */
  setAudioTrackByID(wantedId : string|number) : void {
    const firstPeriod : undefined|ILMPeriodItem = this._periods.head();
    const audioInfos = firstPeriod && firstPeriod.audio;
    if (!audioInfos) {
      throw new Error("LanguageManager: No audio track found in the current period.");
    }

    const foundAdaptation = arrayFind(audioInfos.adaptations, ({ id }) =>
      id === wantedId);

    if (foundAdaptation === undefined) {
      throw new Error("Audio Track not found.");
    }

    addPreference(this._preferredAudioTracks, {
      language: foundAdaptation.language || "",
      normalized: foundAdaptation.normalizedLanguage || "",
      audioDescription: !!foundAdaptation.isAudioDescription,
    });

    if (audioInfos.currentChoice !== foundAdaptation) {
      audioInfos.currentChoice = foundAdaptation;
      audioInfos.adaptation$.next(foundAdaptation);
    }
    this._updateAudioTracks();
  }

  /**
   * Set text track based on the ID of its adaptation.
   *
   * Set text tracks for the next periods accordingly.
   * @param {string|Number} wantedId - adaptation id of the wanted track
   * @throws Error - Throws if the given id is not found in any text adaptation
   */
  setTextTrackByID(wantedId : string|number) : void {
    const firstPeriod : undefined|ILMPeriodItem = this._periods.head();
    const textInfos = firstPeriod && firstPeriod.text;
    if (!textInfos) {
      throw new Error("LanguageManager: No text track found in the current period.");
    }
    const foundAdaptation = arrayFind(textInfos.adaptations, ({ id }) =>
      id === wantedId);

    if (foundAdaptation === undefined) {
      throw new Error("Text Track not found.");
    }

    addPreference(this._preferredTextTracks, {
      language: foundAdaptation.language || "",
      normalized: foundAdaptation.normalizedLanguage || "",
      closedCaption: !!foundAdaptation.isClosedCaption,
    });

    if (textInfos.currentChoice !== foundAdaptation) {
      textInfos.currentChoice = foundAdaptation;
      textInfos.adaptation$.next(foundAdaptation);
    }
    this._updateTextTracks();
  }

  /**
   * Disable the current audio track for any Period.
   */
  disableAudioTrack() : void {
    addPreference(this._preferredAudioTracks, null);
    this._updateAudioTracks();
  }

  /**
   * Disable the current text track for any period.
   */
  disableTextTrack() : void {
    addPreference(this._preferredTextTracks, null);
    this._updateTextTracks();
  }

  /**
   * Returns an object describing the chosen audio track for the first audio
   * Period.
   * This object has the following keys:
   *   - language {string}
   *   - normalized {string}
   *   - audioDescription {Boolean}
   *   - id {number|string}
   *
   * Returns null is the the current audio track is disabled or not
   * set yet.
   * @param {Period} period
   * @returns {Object|null}
   */
  getChosenAudioTrack() : ILMAudioTrack|null {
    const firstAudioPeriod = this._periods.head();
    const audioInfos = firstAudioPeriod && firstAudioPeriod.audio;
    if (audioInfos == null) {
      return null;
    }
    const adaptation = audioInfos.currentChoice;
    if (!adaptation) {
      return null;
    }
    return {
      language: adaptation.language || "",
      normalized: adaptation.normalizedLanguage || "",
      audioDescription: !!adaptation.isAudioDescription,
      id: adaptation.id,
    };
  }

  /**
   * Returns an object describing the chosen text track for the first text
   * Period.
   * This object has the following keys:
   *   - language {string}
   *   - normalized {string}
   *   - closedCaption {Boolean}
   *   - id {number|string}
   *
   * Returns null is the the current text track is disabled or not
   * set yet.
   * @param {Period} period
   * @returns {Object|null}
   */
  getChosenTextTrack() : ILMTextTrack|null {
    const firstTextPeriod = this._periods.head();
    const textInfos = firstTextPeriod && firstTextPeriod.text;
    if (textInfos == null) {
      return null;
    }
    const adaptation = textInfos.currentChoice;
    if (!adaptation) {
      return null;
    }
    return {
      language: adaptation.language || "",
      normalized: adaptation.normalizedLanguage || "",
      closedCaption: !!adaptation.isClosedCaption,
      id: adaptation.id,
    };
  }

  /**
   * Returns all available audio tracks for a given Period, as an array of
   * objects.
   * Those objects have the following keys:
   *   - language {string}
   *   - normalized {string}
   *   - audioDescription {Boolean}
   *   - id {number|string}
   *   - active {Boolean}
   * @returns {Array.<Object>}
   */
  getAvailableAudioTracks() : ILMAudioTrackList {
    const firstAudioPeriod = this._periods.head();
    const audioInfos = firstAudioPeriod && firstAudioPeriod.audio;
    if (audioInfos == null) {
      return [];
    }

    const currentTrack = audioInfos.currentChoice;
    const currentId = currentTrack && currentTrack.id;
    return audioInfos.adaptations
      .map((adaptation) => ({
        language: adaptation.language || "",
        normalized: adaptation.normalizedLanguage || "",
        audioDescription: !!adaptation.isAudioDescription,
        id: adaptation.id,
        active: currentId == null ? false : currentId === adaptation.id,
      }));
  }

  /**
   * Returns all available text tracks for a given Period, as an array of
   * objects.
   * Those objects have the following keys:
   *   - language {string}
   *   - normalized {string}
   *   - closedCaption {Boolean}
   *   - id {number|string}
   *   - active {Boolean}
   * @throws Error - Throws if the given Period has not been added to the
   * LanguageManager.
   * @param {Period} period
   * @returns {Array.<Object>}
   */
  getAvailableTextTracks() : ILMTextTrackList {
    const firstTextPeriod = this._periods.head();
    const textInfos = firstTextPeriod && firstTextPeriod.text;
    if (textInfos == null) {
      return [];
    }

    const currentTrack = textInfos.currentChoice;
    const currentId = currentTrack && currentTrack.id;
    return textInfos.adaptations
      .map((adaptation) => ({
        language: adaptation.language || "",
        normalized: adaptation.normalizedLanguage || "",
        closedCaption: !!adaptation.isClosedCaption,
        id: adaptation.id,
        active: currentId == null ? false : currentId === adaptation.id,
      }));
  }

  private _updateAudioTracks() {
    const preferredAudioTracks = this._preferredAudioTracks;
    const updatedPeriods : Period[] = [];

    for (let i = 0; i < this._periods.length(); i++) {
      const periodItem = this._periods.get(i);
      if (!arrayIncludes(updatedPeriods, periodItem.period)) {
        const audioAdaptations = periodItem.period.adaptations.audio || [];
        if (
          periodItem.audio != null && (
            periodItem.audio.currentChoice === undefined ||
            !isAudioAdaptationOptimal(
              periodItem.audio.currentChoice, audioAdaptations, preferredAudioTracks)
          )
        ) {
          const optimalAdaptation = findFirstOptimalAudioAdaptation(
            audioAdaptations, preferredAudioTracks);

          periodItem.audio.currentChoice = optimalAdaptation;
          periodItem.audio.adaptation$.next(optimalAdaptation);
          updatedPeriods.push(periodItem.period);

          // The array of active periods could have completely changed since
          // then, restart the loop
          i = -1;
        }
      }
    }
  }

  private _updateTextTracks() {
    const preferredTextTracks = this._preferredTextTracks;
    const updatedPeriods : Period[] = [];

    for (let i = 0; i < this._periods.length(); i++) {
      const periodItem = this._periods.get(i);
      if (!arrayIncludes(updatedPeriods, periodItem.period)) {
        const textAdaptations = periodItem.period.adaptations.text || [];
        if (
          periodItem.text != null && (
            periodItem.text.currentChoice === undefined ||
            !isTextAdaptationOptimal(
              periodItem.text.currentChoice, textAdaptations, preferredTextTracks)
          )
        ) {
          const optimalAdaptation = findFirstOptimalTextAdaptation(
            textAdaptations, preferredTextTracks);

          periodItem.text.currentChoice = optimalAdaptation;
          periodItem.text.adaptation$.next(optimalAdaptation);
          updatedPeriods.push(periodItem.period);

          // The array of active periods could have completely changed since
          // then, restart the loop
          i = -1;
        }
      }
    }
  }
}

/**
 * Returns true if the given audio adaptation is an optimal choice for a period
 * given the list of audio adaptations in the period and an array of preferred
 * audio configurations sorted from the most preferred to the least preferred.
 * @param {Adaptation|null} adaptation
 * @param {Array.<Adaptation>} audioAdaptations
 * @param {Array.<Object>} preferredAudioTracks
 * @returns {Boolean}
 */
function isAudioAdaptationOptimal(
  adaptation : Adaptation|null,
  audioAdaptations : Adaptation[],
  preferredAudioTracks : IAudioTrackPreference[]
) : boolean {
  if (!audioAdaptations.length) {
    return adaptation === null;
  }

  for (let i = 0; i < preferredAudioTracks.length; i++) {
    const preferredAudioTrack = preferredAudioTracks[i];

    if (preferredAudioTrack === null) {
      return adaptation === null;
    }

    const foundAdaptation = arrayFind(audioAdaptations, (audioAdaptation) =>
      audioAdaptation.normalizedLanguage === preferredAudioTrack.normalized &&
      !!audioAdaptation.isAudioDescription === preferredAudioTrack.audioDescription
    );

    if (foundAdaptation !== undefined) {
      if (adaptation === null) {
        return false;
      }

      return (
        (foundAdaptation.normalizedLanguage || "") ===
        (adaptation.normalizedLanguage || "")
      ) && !!foundAdaptation.isAudioDescription === !!adaptation.isAudioDescription;
    }

  }
  return true; // no optimal adaptation, just return true
}

/**
 * Find an optimal audio adaptation given their list and the array of preferred
 * audio tracks sorted from the most preferred to the least preferred.
 *
 * null if the most optimal audio adaptation is no audio adaptation.
 * @param {Array.<Adaptation>} audioAdaptations
 * @returns {Adaptation|null}
 */
function findFirstOptimalAudioAdaptation(
  audioAdaptations : Adaptation[],
  preferredAudioTracks : IAudioTrackPreference[]
) : Adaptation|null {
  if (!audioAdaptations.length) {
    return null;
  }

  for (let i = 0; i < preferredAudioTracks.length; i++) {
    const preferredAudioTrack = preferredAudioTracks[i];

    if (preferredAudioTrack === null) {
      return null;
    }

    const foundAdaptation = arrayFind(audioAdaptations, (audioAdaptation) =>
      (audioAdaptation.normalizedLanguage || "") === preferredAudioTrack.normalized &&
      !!audioAdaptation.isAudioDescription === preferredAudioTrack.audioDescription
    );

    if (foundAdaptation !== undefined) {
      return foundAdaptation;
    }

  }

  // no optimal adaptation, just return the first one
  return audioAdaptations[0];
}

/**
 * Returns true if the given text adaptation is an optimal choice for a period
 * given the list of text adaptations in the period and an array of preferred
 * text configurations sorted from the most preferred to the least preferred.
 * @param {Adaptation|null} adaptation
 * @param {Array.<Adaptation>} audioAdaptations
 * @param {Array.<Object>} preferredAudioTracks
 * @returns {Boolean}
 */
function isTextAdaptationOptimal(
  adaptation : Adaptation|null,
  textAdaptations : Adaptation[],
  preferredTextTracks : ITextTrackPreference[]
) : boolean {
  if (!textAdaptations.length) {
    return adaptation === null;
  }

  for (let i = 0; i < preferredTextTracks.length; i++) {
    const preferredTextTrack = preferredTextTracks[i];

    if (preferredTextTrack === null) {
      return adaptation === null;
    }

    const foundAdaptation = arrayFind(textAdaptations, (textAdaptation) =>
      (textAdaptation.normalizedLanguage || "") === preferredTextTrack.normalized &&
      !!textAdaptation.isClosedCaption === preferredTextTrack.closedCaption
    );

    if (foundAdaptation !== undefined) {
      if (adaptation === null) {
        return false;
      }

      return (
        (foundAdaptation.normalizedLanguage || "") ===
        (adaptation.normalizedLanguage || "")
      ) && !!foundAdaptation.isClosedCaption === !!adaptation.isClosedCaption;
    }

  }
  return adaptation === null;
}

/**
 * Find an optimal text adaptation given their list and the array of preferred
 * text tracks sorted from the most preferred to the least preferred.
 *
 * null if the most optimal text adaptation is no text adaptation.
 * @param {Array.<Adaptation>} audioAdaptations
 * @returns {Adaptation|null}
 */
function findFirstOptimalTextAdaptation(
  textAdaptations : Adaptation[],
  preferredTextTracks : ITextTrackPreference[]
) : Adaptation|null {
  if (!textAdaptations.length) {
    return null;
  }

  for (let i = 0; i < preferredTextTracks.length; i++) {
    const preferredTextTrack = preferredTextTracks[i];

    if (preferredTextTrack === null) {
      return null;
    }

    const foundAdaptation = arrayFind(textAdaptations, (textAdaptation) =>
      (textAdaptation.normalizedLanguage || "") === preferredTextTrack.normalized &&
      !!textAdaptation.isClosedCaption === preferredTextTrack.closedCaption
    );

    if (foundAdaptation !== undefined) {
      return foundAdaptation;
    }

  }

  // no optimal adaptation
  return null;
}

function findPeriodIndex(
  periods : SortedList<ILMPeriodItem>,
  period : Period
) : number|undefined {
  for (let i = 0; i < periods.length(); i++) {
    const periodI = periods.get(i);
    if (periodI.period.id === period.id) {
      return i;
    }
  }
}

function getPeriodItem(
  periods : SortedList<ILMPeriodItem>,
  period : Period
) : ILMPeriodItem|undefined {
  for (let i = 0; i < periods.length(); i++) {
    const periodI = periods.get(i);
    if (periodI.period.id === period.id) {
      return periodI;
    }
  }
}

function addPreference<T extends IAudioTrackPreference|ITextTrackPreference>(
  preferences : T[],
  preference : T
) {
  // TODO only one reference of the same language per Array?
  if (preferences.length >= PREFERENCES_MAX_LENGTH - 1) {
    preferences.pop();
  }
  preferences.unshift(preference);
}
