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
import { IRepresentationChooserClockTick } from "./representation_chooser";

export default function getABRFactor(
    clock$: Observable<IRepresentationChooserClockTick>,
    startFactor: number,
    endFactor: number,
    increaseDuration: number
) {
    const firstStep = Math.log(startFactor + 1);
    const lastStep = Math.log(endFactor + 1);
    const step = (lastStep - firstStep) / increaseDuration;
    return clock$
        .scan((x: number,y) => {
            return Math.min((y.position - (x || 0)), increaseDuration);
        })
        .map(elapsed => {
             // return factor value
            return (Math.exp(firstStep + elapsed*step) - 1);
        });
    }
