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
 *
 * That is, Periods for which a Buffer is currently active.
 */

import { BehaviorSubject } from "rxjs/BehaviorSubject";
import { Period } from "../../manifest";
import log from "../../utils/log";
import SortedList from "../../utils/sorted_list";
import { SupportedBufferTypes } from "../types";

/**
 * Store active Periods as they are added/removed associated with their linked
 * active buffer types.
 *
 * Emit the first chronological Period each time it changes.
 *
 * Periods here are assumed to respect the following rules:
 *   - The first chronological Period stored is the currently played one.
 *   - Any subsequent ones are pre-loaded Periods, consecutive chronologically.
 *
 * @class ActivePeriodsStore
 */
export default class ActivePeriodsStore {
  /**
   * Emit the first chronological Period each times it changes.
   * null when there is none.
   * @type {BehaviorSubject}
   */
  public firstPeriod$ : BehaviorSubject<Period|null>;

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
    this.firstPeriod$ = new BehaviorSubject<Period|null>(null);
  }

  /**
   * @returns {Period|null}
   */
  getFirst() : Period | null {
    return this.firstPeriod$.getValue();
  }

  /**
   * add a new Period to the list
   * @param {Period} period
   * @param {string} type
   */
  add(period : Period, type : SupportedBufferTypes) {
    // add or update the periodItem
    const periodItem = this._periodsList.find(p => p.period === period);
    if (periodItem) {
      // Period already added, just add the buffer type to it.
      periodItem.buffers.add(type);
      return;
    }

    const newPeriodItem = {
      period,
      buffers: new Set<SupportedBufferTypes>(),
    };
    newPeriodItem.buffers.add(type); // on another line for TS

    const isFirst = this._periodsList.isBefore(newPeriodItem);
    this._periodsList.add(newPeriodItem);

    if (isFirst) {
      this.firstPeriod$.next(period);
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
        const newFirstPeriod = this._periodsList.head();
        this.firstPeriod$.next(newFirstPeriod ? newFirstPeriod.period : null);
      }
    }
  }

  /**
   * Returns every active buffer types, as a set, for the given Period.
   * null if the Period is not found.
   * @param {Period} period
   * @returns {Set|null}
   */
  getBufferTypes(period : Period) : Set<SupportedBufferTypes>|null {
    const periodItem = this._periodsList.find((p => p.period === period));
    return (periodItem && periodItem.buffers) || null;
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
