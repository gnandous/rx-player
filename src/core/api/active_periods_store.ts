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
 * This file helps to keep track of the currently active Periods.
 * That is, Periods for which at least a single Buffer is currently active.
 *
 * It also keep track of the currently active period:
 * The first chronological period for which all types of buffers are active.
 */

// TODO
// This turns out to be a mess
// The Stream should probably emit a "currentPeriodChanged" event instead.

import { BehaviorSubject } from "rxjs/BehaviorSubject";
import { Period } from "../../manifest";
import log from "../../utils/log";
import SortedList from "../../utils/sorted_list";
import {
  BUFFER_TYPES,
  SupportedBufferTypes,
} from "../source_buffers";

/**
 * Returns true if the set of given buffer types is complete (has all possible
 * types).
 * @param {Set} bufferList
 * @returns {Boolean}
 */
function isBufferListFull(bufferList : Set<SupportedBufferTypes>) : boolean {
  return bufferList.size >= BUFFER_TYPES.length;
}

/**
 * @param {SortedList}
 * @returns {Boolean}
 */
function isFirstInSortedList<T>(list : SortedList<T>, item : T) : boolean {
  return list.indexOf(item) === 0;
}

/**
 * Store active Periods as they are added/removed associated with their linked
 * active buffer types.
 *
 * Emit the currently active Period each time it changes.
 *
 * Periods added and removed here are assumed to respect the following rules:
 *   - The first chronological Period stored is the currently played one.
 *   - Every possible buffer types are added / removed.
 *   - Any subsequent ones are pre-loaded Periods, consecutive chronologically.
 *
 * @class ActivePeriodsStore
 */
export default class ActivePeriodsStore {
  /**
   * @type {BehaviorSubject}
   */
  public activePeriod$ : BehaviorSubject<Period|null>;

  /**
   * Store every active Periods and their linked buffer types, in chronological
   * order.
   * @private
   * @type {SortedList}
   */
  private _periodsList : SortedList<{
    period: Period;
    buffers: Set<SupportedBufferTypes>;
  }>;

  constructor() {
    this._periodsList = new SortedList((a, b) => a.period.start - b.period.start);
    this.activePeriod$ = new BehaviorSubject<Period|null>(null);
  }

  /**
   * @returns {Period|null}
   */
  getCurrentPeriod() : Period | null {
    return this.activePeriod$.getValue();
  }

  isCurrentPeriod(period : Period) : boolean {
    return period === this.activePeriod$.getValue();
  }

  /**
   * add a new Period to the list
   * @param {Period} period
   * @param {string} type
   */
  add(period : Period, type : SupportedBufferTypes) {
    // add or update the periodItem
    let periodItem = this._periodsList.find(p => p.period === period);
    if (!periodItem) {
      periodItem = {
        period,
        buffers: new Set<SupportedBufferTypes>(),
      };
      this._periodsList.add(periodItem);
    }
    if (periodItem.buffers.has(type)) {
      log.warn(`Buffer type ${type} already added to the period`);
      return;
    }
    periodItem.buffers.add(type); // on another line for TS

    // When the first chronological Period has all buffer types
    // added, we can start to emit the currently active period
    if (
      isFirstInSortedList(this._periodsList, periodItem) &&
      isBufferListFull(periodItem.buffers)
    ) {
      this.activePeriod$.next(period);
    }
  }

  /**
   * Remove a Period from the list, because it's not considered active anymore.
   * @param {Period} period
   * @param {string} type
   */
  remove(period : Period, type : SupportedBufferTypes) {
    if (!this._periodsList || this._periodsList.length() === 0) {
      log.error("ActivePeriodsStore: cannot remove, no period is active.");
      return;
    }

    const periodItem = this._periodsList.find(p => p.period === period);
    if (!periodItem) {
      log.error("ActivePeriodsStore: cannot remove, unknown period.");
      return;
    }

    periodItem.buffers.delete(type);

    if (!periodItem.buffers.size) {
      const indexOf = this._periodsList.removeFirst(periodItem);

      if (indexOf === 0) {
        const newActivePeriod = this._periodsList.head();

        // only emit the new active period if all buffers have been added yet
        if (newActivePeriod && isBufferListFull(newActivePeriod.buffers)) {
          this.activePeriod$.next(newActivePeriod.period);
        }
      }
    }
  }

  /**
   * Returns the current list of Periods, sorted chronologically.
   * @returns {Array.<Period>}
   */
  getList() : Period[] {
    return this._periodsList.unwrap()
      .map(p => p.period);
  }
}
