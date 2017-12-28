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
import log from "../../utils/log";

/**
 * Maintains a list of consecutive Periods.
 *
 * Adds methods to push/remove them and to know whether a given time goes out
 * of its bounds.
 * Can be used to maintain a list of currently active buffers, by keeping track
 * of which Period each one of them are linked to.
 *
 * /!\ This class can only contain a _consecutive_ list of Periods.
 * @example
 *
 * TODO Globalize to a "Range" thingy?
 * TODO This is too specific and smart, should be removed/simplified.
 * ```js
 * const list = new ConsecutivePeriodsList();
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
 *
 * // Note 1: it's impossible to remove a period which is between
 * // other periods:
 * const list2 = new ConsecutivePeriodsList();
 * list2.add(period1);
 * list2.add(period2);
 * list2.add(period3);
 *
 * // This will throw
 * list2.remove(period2);
 *
 * // Note 2: it's impossible to add a period which is between
 * // other periods:
 * const list3 = new ConsecutivePeriodsList();
 * list3.add(period1);
 *
 * // this will work
 * list3.add(period3);
 *
 * // but this will throw
 * list3.add(period2);
 *
 * ```
 * @class ConsecutivePeriodsList
 */
export default class ConsecutivePeriodsList {
  private _periods: Period[];

  constructor() {
    this._periods = [];
  }

  /**
   * Add a period to the list.
   * The period should either come before the list of Periods already there
   * or after.
   * The period won't be added if it's already in the list.
   * @param {Period} period
   */
  add(period : Period) {
    if (!this._periods.length) {
      this._periods.push(period);
      return;
    }

    const firstPeriod = this._periods[0];
    if (period.start < firstPeriod.start) {
      this._periods.unshift(period);
      return;
    } else if (period.start > firstPeriod.start) {
      if (this._periods.length === 1) {
        this._periods.push(period);
        return;
      }
      const lastPeriod = this._periods[this._periods.length - 1];
      if (lastPeriod.start < period.start) {
        this._periods.push(period);
      } else {
        throw new Error("ConsecutivePeriodsList: the given Period is not at the edge");
      }
    } else {
      log.warn("ConsecutivePeriodsList: Cannot push two Periods with the same start.");
    }
  }

  /**
   * Remove a Period from the list.
   * @param {Period} period
   */
  remove(period : Period) {
    if (period === this._periods[0]) {
      this._periods.shift();
    } else if (period === this._periods[this._periods.length-1]) {
      this._periods.pop();
    } else {
      if (this._periods.indexOf(period) === -1) {
        log.warn("ConsecutivePeriodsList: Cannot remove Period: not found.");
      } else {
        throw new Error("ConsecutivePeriodsList: Cannot remove Period: not at the edge");
      }
    }
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
    const period = this._periods[0];
    return !period || period.start > time;
  }

  /**
   * @param {number} time
   * @returns {boolean}
   */
  isAfter(time : number) : boolean {
    const period = this._periods[this._periods.length - 1];
    return !period || (period.end != null && period.end <= time);
  }
}
