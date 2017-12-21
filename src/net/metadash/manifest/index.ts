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

import parseMPD, {
    IContentProtectionParser,
    IParsedMPD,
} from "../../dash/manifest/node_parsers";

import { IParsedPeriod } from "../../dash/manifest/node_parsers/Period";

import generateNewId from "../../../utils/id";

import patchSegmentsIndex from "./index_patcher";

import config from "../../../config";

const { DEFAULT_LIVE_GAP } = config;

export function parseFromMetaDocument(
    documents: {
      manifests: Array<{
        manifest: Document;
        url: string;
      }>;
      startTime: number;
      looped: number;
    },
    baseURL?: string,
    contentProtectionParser?: IContentProtectionParser
  ) {
    const manifests = documents.manifests;
    const parsedManifests = manifests.map((document) => {
      const root = document.manifest.documentElement;
      if (!root || root.nodeName !== "MPD") {
        throw new Error("document root should be MPD");
      }
      return parseMPD(root, document.url, contentProtectionParser);
    });

    // 1 - Get period durations
    const parsedPeriods = parsedManifests
      .map((mpd: IParsedMPD) => mpd.periods)
      .reduce((acc, periods) => acc.concat(periods), []);
    const durations : number[]
      = parsedPeriods.map((period: IParsedPeriod) => period.duration || 0);
    const totalDuration = durations.reduce((a, b) => a + b, 0);
    const averageDuration = totalDuration / durations.length;

    // 2 - Find on which period playback may start
    const plg = (parsedManifests.map(man => man.presentationLiveGap)
      .reduce((acc, val) =>
        Math.min(acc || DEFAULT_LIVE_GAP, val ||DEFAULT_LIVE_GAP), DEFAULT_LIVE_GAP
      )) || DEFAULT_LIVE_GAP;
    const spd = (parsedManifests.map(man => man.suggestedPresentationDelay)
      .reduce((acc, val) =>
        Math.min(acc || 10, val || 10), 10
      )) || 10;
      const tsbd = (parsedManifests.map(man => man.timeShiftBufferDepth)
      .reduce((acc, val) =>
        Math.min(acc || 0, val || 0), 0
      )) || 0;
    const playbackPosition = (Date.now() / 1000) - (documents.startTime || 0) - plg - spd;
    const elapsedLoops = Math.floor(playbackPosition / totalDuration);
    const timeOnLoop = playbackPosition % totalDuration;
    let elapsedTimeOnLoop = 0;
    let index = 0;
    while(timeOnLoop > elapsedTimeOnLoop){
      const test = elapsedTimeOnLoop + durations[index];
      if(timeOnLoop >= test){
        elapsedTimeOnLoop = test;
        index++;
      } else {
        break;
      }
    }

    // 3 - Build new periods array
    const newPeriods = [];
    const currentStart: number = elapsedLoops * totalDuration;

    for(let j = 0; j < durations.length; j++){
      const newIndex = (j+index) % durations.length;
      const newPeriod = parsedPeriods[newIndex];

      newPeriod.start = currentStart + elapsedTimeOnLoop;
      patchSegmentsIndex(newPeriod);
      elapsedTimeOnLoop += newPeriod.duration || 0;
      newPeriod.end = newPeriod.start + (newPeriod.duration || 0);
      newPeriod.id = "p" + Math.round(newPeriod.start);
      newPeriods.push(newPeriod);
    }

    // In case where live edge is a little before first period position,
    // we duplicate last period at beginning
    const firstPeriodRef = newPeriods[newPeriods.length -1];
    const firstAdaptations = firstPeriodRef.adaptations;
    const firstStart = firstPeriodRef.duration ?
      newPeriods[0].start - firstPeriodRef.duration :
      firstPeriodRef.end;

      if(firstStart && firstStart >= 0) {
        newPeriods.splice(0, 0, {
          adaptations: firstAdaptations,
          duration: firstPeriodRef.duration,
          id: "p" + Math.round(firstStart),
          start: firstStart,
        });
      }

    // Last period may not present duration or end (live condition)
    newPeriods[newPeriods.length-1].duration = undefined;
    newPeriods[newPeriods.length-1].end = undefined;

    const manifest = {
      availabilityStartTime: documents.startTime,
      presentationLiveGap: plg,
      timeShiftBufferDepth: tsbd,
      duration: Infinity,
      id: "gen-metadash-man-"+generateNewId(),
      maxSegmentDuration:
        parsedManifests.map(man => man.maxSegmentDuration)
          .reduce((acc, val) => Math.min((acc || 0),(val || 0)), 0),
      minBufferTime:
        parsedManifests.map(man => man.minBufferTime)
          .reduce((acc, val) => Math.min((acc || 0),(val || 0)), 0),
      profiles: "urn:mpeg:dash:profile:isoff-live:2011",
      periods: newPeriods,
      suggestedPresentationDelay: spd,
      minimumUpdatePeriod: averageDuration / 2,
      transportType: "metadash",
      type: "dynamic",
      uris: [baseURL || ""],
    };

    return manifest;
  }
