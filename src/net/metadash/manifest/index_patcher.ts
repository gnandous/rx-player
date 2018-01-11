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

import { IParsedAdaptationSet } from "../../dash/manifest/node_parsers/AdaptationSet";
import { IParsedPeriod } from "../../dash/manifest/node_parsers/Period";

export default function patchSegmentsIndex(period: IParsedPeriod) {
    const adapt = JSON.parse(JSON.stringify(period.adaptations));
    delete period.adaptations;
    adapt.forEach((adaptation: IParsedAdaptationSet) => {
      const reps = JSON.parse(JSON.stringify(adaptation.representations));
      delete adaptation.representations;
      reps.forEach((rep) => {
        const index = rep.index;
        if(index.tokenOffset == null){
          index.tokenOffset = period.start;
          if(index.timeline != null && period.start != null){
            index.timeline.forEach((tl: any) => {
              tl.ts += ((period.start || 0) * index.timescale);
          });
          }
        }
      });
      adaptation.representations = reps;
    });
    period.adaptations = adapt;
}
