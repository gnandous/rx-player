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
    period.adaptations.forEach((adaptation: IParsedAdaptationSet) => {
      const index = adaptation.representations[0].index;
      if(index.timeline && period.start != null){
        index.timeline.forEach((tl: any) => {
          index.tokenOffset = period.start;
            tl.ts += ((period.start || 0) * index.timescale);
        });
      }
      else if(index.startNumber && period.start){
        index.tokenOffset = period.start;
      } else {
        throw new Error("Start time may be spcified on period.");
      }
    });
}
