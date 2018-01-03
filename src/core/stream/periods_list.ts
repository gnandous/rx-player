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

import { Period } from "../../manifest";
import SortedList from "../../utils/sorted_list";

/**
 * Maintains a list of consecutive Periods.
 *
 * Adds methods to push/remove them and to know whether a given time goes out
 * of its bounds.
 * Can be used to maintain a list of currently active buffers, by keeping track
 * of which Period each one of them are linked to.
 *
 * @example
 *
 * TODO Globalize to a "Range" thingy?
 * ```js
 * const list = new PeriodsList();
 *
 * list.add(period1);
 * list.add(period2);
 *
 * console.log(list.isOutOfBounds(timeInPeriod1)); // => false
 * console.log(list.isOutOfBounds(timeInPeriod2)); // => false
 * console.log(list.isOutOfBounds(timeInPeriod3)); // => true
 *
 * list.add(period3);
 *
 * console.log(list.isOutOfBounds(timeInPeriod1)); // => false
 * console.log(list.isOutOfBounds(timeInPeriod2)); // => false
 * console.log(list.isOutOfBounds(timeInPeriod3)); // => false
 *
 * list.remove(period1);
 *
 * console.log(list.isOutOfBounds(timeInPeriod1)); // => true
 * console.log(list.isOutOfBounds(timeInPeriod2)); // => false
 * console.log(list.isOutOfBounds(timeInPeriod3)); // => false
 *
 * list.remove(period2);
 * list.remove(period3);
 * console.log(list.isOutOfBounds(timeInPeriod1)); // => true
 * console.log(list.isOutOfBounds(timeInPeriod2)); // => true
 * console.log(list.isOutOfBounds(timeInPeriod3)); // => true
 * ```
 * @class PeriodsList
 */
export default class PeriodsList {
  private _periods : SortedList<Period>;

  constructor() {
    this._periods = new SortedList<Period>((a, b) => a.start - b.start);
  }

  /**
   * Add a period to the list.
   * @param {Period} period
   */
  add(period : Period) {
    this._periods.add(period);
  }

  /**
   * Remove a Period from the list.
   * @param {Period} period
   */
  remove(period : Period) {
    this._periods.removeFirst(period);
  }

  /**
   * @param {number} time
   * @returns {boolean}
   */
  isOutOfBounds(time : number) : boolean {
    return this.isBefore(time) || this.isAfter(time);
  }

  /**
   * @param {number} time
   * @returns {boolean}
   */
  isBefore(time : number) : boolean {
    const period = this._periods.head();
    return !period || period.start > time;
  }

  /**
   * @param {number} time
   * @returns {boolean}
   */
  isAfter(time : number) : boolean {
    const period = this._periods.last();
    return !period || (period.end != null && period.end <= time);
  }
}
