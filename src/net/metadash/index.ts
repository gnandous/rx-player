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

import { IDASHOptions } from "../dash/index";

import request from "../../utils/request";

import parseBif from "../../parsers/images/bif";

import BoxPatcher from "./isobmff_patcher";

import {
  addNextSegments,
  replaceTokens,
} from "../dash/utils";

import { resolveURL } from "../../utils/url";

import {
  getMDHDTimescale,
  parseSidx,
} from "../../parsers/containers/isobmff";

import getISOBMFFTimingInfos from "../dash/isobmff_timing_infos";

import { parseFromMetaDocument } from "../metadash/manifest";

import {
  loader as TextTrackLoader,
  parser as TextTrackParser,
} from "../dash/texttracks";

import {
    ILoaderObservable,
    ImageParserObservable,
    IManifestLoaderArguments,
    IManifestParserArguments,
    IManifestParserObservable,
    INextSegmentsInfos,
    ISegmentLoaderArguments,
    ISegmentParserArguments,
    ISegmentTimingInfos,
    ITransportPipelines,
    SegmentParserObservable,
  } from "../types";

import generateSegmentLoader from "../dash/segment_loader";

interface IMetaManifestInfo {
    manifests: Array<{
      manifest: Document;
      url: string;
    }>;
    startTime: number;
}

function loadMetaData(data: any): {
  urls: string[];
  startTime: number;
} {
  return {
    urls: data.urls,
    startTime: data.startTime,
  };
}

export default function(
    dashOptions: IDASHOptions = {}
): ITransportPipelines<
    IMetaManifestInfo,
    ArrayBuffer|Uint8Array,
    ArrayBuffer|Uint8Array,
    ArrayBuffer|string,
    ArrayBuffer
>{
    const segmentLoader = generateSegmentLoader(dashOptions.segmentLoader);
    const { contentProtectionParser } = dashOptions;

    const manifestPipeline = {
      loader(
        { url } : IManifestLoaderArguments
      ) : ILoaderObservable<IMetaManifestInfo> {
        // Load meta-manifest as document
        return request({
          url,
          ignoreProgressEvents: true,
        }).mergeMap(({ value }) => {
          const data = value.responseData;
          const metaData = loadMetaData(data); // load data from meta document
          const manifests$ = metaData.urls.map((adresse) => {
            return request({ // requests documents contents
              url: adresse,
              responseType: "document",
              ignoreProgressEvents: true,
            }).map(({ value: val }) => {
              return {
                manifest: val.responseData,
                url: adresse,
              };
            });
          });

          return Observable
            .combineLatest(manifests$)
            .map((manifests) => {
              return {
              type: "response" as "response",
              value: {
                responseData: {
                  manifests,
                  startTime: metaData.startTime,
                },
              },
            };
          });
        });
      },

      parser(
        { response, url } : IManifestParserArguments<IMetaManifestInfo>
      ) : IManifestParserObservable {
        const data = response.responseData;
        const manifest = parseFromMetaDocument(data, url, contentProtectionParser);
        return Observable.of({
          manifest,
          url,
        });
      },
    };

      const segmentPipeline = {
        loader({
          adaptation,
          init,
          manifest,
          period,
          representation,
          segment,
        } : ISegmentLoaderArguments) : ILoaderObservable<Uint8Array|ArrayBuffer> {
          return segmentLoader({
            adaptation,
            init,
            manifest,
            period,
            representation,
            segment,
          });
        },

        parser({
          segment,
          representation,
          response,
          init,
          period,
        } : ISegmentParserArguments<Uint8Array|ArrayBuffer>
        ) : SegmentParserObservable {
          const responseData = response.responseData instanceof Uint8Array
          ? response.responseData
           : new Uint8Array(response.responseData);

          const offset = period.start || 0;
          console.log(offset);
          let nextSegments : INextSegmentsInfos[]|undefined;
          let segmentInfos : ISegmentTimingInfos;

          const indexRange = segment.indexRange;
          const sidxSegments =
            parseSidx(responseData, indexRange ? indexRange[0] : 0);
          if (sidxSegments) {
            nextSegments = sidxSegments;
          }
          const segmentData = new BoxPatcher(
            responseData,
            false,
            false,
            offset * (init ? (init.timescale || segment.timescale) :  segment.timescale)
          ).filter();

          if (segment.isInit) {
            segmentInfos = { time: -1, duration: 0 };
            const timescale = getMDHDTimescale(segmentData);
            if (timescale > 0) {
              segmentInfos.timescale = timescale;
            }
          } else {
            segmentInfos =
              getISOBMFFTimingInfos(segment, segmentData, sidxSegments, init);
          }

          if (nextSegments) {
            addNextSegments(representation, segmentInfos, nextSegments);
          }
          return Observable.of({ segmentData, segmentInfos });
        },
      };

      const textTrackPipeline = {
        loader: TextTrackLoader,
        parser: TextTrackParser,
      };

      const imageTrackPipeline = {
        loader(
          { segment, representation, period } : ISegmentLoaderArguments
        ) : ILoaderObservable<ArrayBuffer> {
          const { isInit } = segment;

          if (isInit) {
            return Observable.empty();
          } else {
            const { media } = segment;

            const path = media ?
              replaceTokens(media, segment, representation, period) : "";
            const mediaUrl = resolveURL(representation.baseURL, path);
            return request({
              url: mediaUrl,
              responseType: "arraybuffer",
            });
          }
        },

        parser(
          { response } : ISegmentParserArguments<ArrayBuffer>
        ) : ImageParserObservable {
          const responseData = response.responseData;
          const blob = new Uint8Array(responseData);

          const bif = parseBif(blob);
          const segmentData = bif.thumbs;

          const segmentInfos = {
            time: 0,
            duration: Number.MAX_VALUE,
            timescale: bif.timescale,
          };

          // var firstThumb = blob[0];
          // var lastThumb  = blob[blob.length - 1];

          // segmentInfos = {
          //   time: firstThumb.ts,
          //   duration: lastThumb.ts
          // };

          return Observable.of({ segmentData, segmentInfos });
        },
      };

      return {
        manifest: manifestPipeline,
        audio: segmentPipeline,
        video: segmentPipeline,
        text: textTrackPipeline,
        image: imageTrackPipeline,
      };
}
