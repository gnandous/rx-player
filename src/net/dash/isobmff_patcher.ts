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

import {
    be2toi,
    be4toi,
    be8toi,
    bytesToHex,
    bytesToStr,
    concat,
    hexToBytes,
    itobe2,
    itobe4,
    itobe8,
    strToBytes,
  } from "../../utils/bytes";

function ord(string: string) {
  const str = string + "";
  const code = str.charCodeAt(0);
  if (code >= 0xD800 && code <= 0xDBFF) {
    const hi = code;
    if (str.length === 1) {
      return code;
    }
    const low = str.charCodeAt(1);
    return ((hi - 0xD800) * 0x400) + (low - 0xDC00) + 0x10000;
  }
  if (code >= 0xDC00 && code <= 0xDFFF) {
    return code;
  }
  return code;
}

function chr(codePt: any): string {
  if (codePt > 0xFFFF) {
    const modCodePt = codePt - 0x10000;
    return String.fromCharCode(
        (modCodePt >> 10) + 0xD800,
        (modCodePt & 0x3FF) + 0xDC00
      );
  }
  return String.fromCharCode(codePt);
}

export default class BoxPatchers {
    private offset: number;
    private seg_duration: number;
    private lmsg;
    private scte35_per_minute = 0;
    private is_ttml = false;
    private seg_nr;
    private track_timescale;
    private rel_path;
    private top_level_boxes_to_parse = [];
    private composite_boxes_to_parse = [];
    private size_change = 0;
    private tfdt_value: number;
    private duration: number;
    private ttml_size;
    private data: Uint8Array;

    constructor(
        file_name: string,
        seg_duration?,
        offset?: number,
        lmsg?,
        scte35_per_minute?,
        is_ttml?,
        seg_nr?: number,
        track_timescale?: number,
        rel_path?: string
    ){
        this.top_level_boxes_to_parse = ["styp", "sidx", "moof", "mdat"];
        this.composite_boxes_to_parse = ["moof", "traf"];
        this.seg_nr = seg_nr;
        this.seg_duration = seg_duration || 1;
        this.offset = offset || 0;
        this.track_timescale = track_timescale;
        this.rel_path = rel_path;
        this.lmsg = lmsg || false;
        this.scte35_per_minute = scte35_per_minute || 0;
        this.is_ttml = is_ttml || false;
        if(this.is_ttml){
            this.data = this.find_and_process_mdat(this.data);
        }
    }

      /**
       * Process styp and make sure lmsg presence follows the lmsg flag parameter.
       * Add scte35 box if appropriate
       * @param {Uint8Array} input
       * @return {Uint8Array} patched box
       */
      styp(input: Uint8Array): Uint8Array {
        const lmsg = this.lmsg;
        const size = be4toi(input, 0);
        let pos = 8;
        const brands = [];
        while (pos < size){
            const brand = input.subarray(pos, pos+4);
            if (bytesToStr(brand) !== "lmsg"){
                brands.push(brand);
            }
            pos += 4;
        }
        if (lmsg){
          brands.push(strToBytes("lmsg"));
        }
        const data_size = brands.length * 4;
        const data = new Uint8Array(data_size);

        for (let i = 0; i < brands.length; i++){
          data.set(brands[i], i*4);
        }
        const scte35box = this.create_scte35box();
        return Atom("styp", concat(data, scte35box));
      }

      /**
       *   "Process tfhd (assuming that we know the ttml size size)."
       */
      tfhd(input: Uint8Array): Uint8Array {
        let output = new Uint8Array(0);
        if (!this.is_ttml){
          return input;
        }
        const tf_flags = be4toi(input.subarray(8,12), 0) & 0xFFFFFF; // good func ?
        let pos = 16;
        if(tf_flags & 0x01) {
          throw new Error("base-data-offset-present not supported in ttml segments");
        }
        if(tf_flags & 0x02) {
          pos += 4;
        }
        if((tf_flags & 0x08) === 0) {
          throw new Error("Cannot handle ttml segments with default_sample_duration absent");
        } else {
          pos += 4;
        }
        if(tf_flags && 0x10) {
          output = concat(input.subarray(0, pos), itobe4(this.ttml_size));
        }
        else{
          throw new Error(
            "Cannot handle ttml segments if default_sample_size_offset is absent"
          );
        }
        output = concat(output, input.subarray(pos, input.length));
        return output;
      }

      /**
       * Process mfhd box and set segmentNumber if requested.
       */
      mfhd(input: Uint8Array): Uint8Array {
        if(!this.seg_nr){
          return input;
        }
        const prefix = input.subarray(0, 12);
        const seg_nr_byte = itobe4(this.seg_nr); // good fun ?
        return concat(prefix, seg_nr_byte);
      }

      /**
       * Get total duration from trun.
       * Fix offset if self.size_change is non-zero.
       */
      trun(input: Uint8Array): Uint8Array {
        const flags = be4toi(input, 8) & 0xFFFFFF;
        const sample_count = be4toi(input, 16);
        let pos = 16;
        let data_offset_present = false;
        // Data offset present
        if (flags & 0x1) {
          data_offset_present = true;
          pos += 4;
        }
        // First sample flags present
        if (flags & 0x4){
            pos += 4;
        }
        const sample_duration_present = flags & 0x100;
        const sample_size_present = flags & 0x200;
        const sample_flags_present = flags & 0x400;
        const sample_comp_time_present = flags & 0x800;
        let duration = 0;

        for (let i = 0; i<sample_count; i++){
          if (sample_duration_present){
              duration += be4toi(input, pos);
              pos += 4;
          }
          if (sample_size_present){
            pos += 4;
          }
          if (sample_flags_present){
              pos += 4;
        }
          if (sample_comp_time_present){
              pos += 4;
          }
        }

        this.duration = duration;

        // Modify data_offset
        let output = input.subarray(0, 16);

        if (data_offset_present && this.size_change > 0){
          let offset = be4toi(input, 16);
          offset += this.size_change;
          output = concat(output, itobe4(offset)); // func
        }
        else {
          output = concat(output, input.subarray(16,20));
        }
        output = concat(output, input.subarray(20, input.length));
        return output;
      }

      /**
       * Process sidx data and add to output.
       */
      sidx(input: Uint8Array, keep_sidx: boolean): Uint8Array {
        let output = new Uint8Array(0);
        if(!keep_sidx) {
          return output;
        }
        let earliest_presentation_time;
        let first_offset;
        const version = ord(input[8].toString());
        const timescale = be4toi(input, 16);
        if(version === 0) {
            // Changing sidx version to 1
            const size = be4toi(input, 0);
            const sidx_size_expansion = 8;
            output = concat(output,itobe4(size+sidx_size_expansion)); // func
            output = concat(output, input.subarray(4,8));
            output = concat(output, strToBytes(chr(1)));
            output = concat(output, input.subarray(9, 20));
            earliest_presentation_time = be4toi(input, 20);
            first_offset = be4toi(input, 24);
        }
        else {
          output = concat(output, input.subarray(0, 20));
          earliest_presentation_time = be8toi(input, 20);
          first_offset = be8toi(input, 28);
        }
        const new_presentation_time = earliest_presentation_time + timescale*this.offset;
        output = concat(output, itobe8(new_presentation_time));
        output = concat(output, itobe8(first_offset));
        const suffix_offset = version === 0 ? 28 : 36;
        output = concat(output, input.subarray(suffix_offset, input.length));
        return output;
      }

      /**
       * Generate new timestamps for tfdt and change size of boxes above if needed.
       * Try to keep in 32 bits if possible.
       * @param input
       */
      tfdt(input: Uint8Array): Uint8Array{
        const version = ord(input[8].toString());
        const tfdt_offset = this.offset*this.track_timescale;
        let output = new Uint8Array(0);
        let new_base_media_decode_time;
        // 32-bit baseMediaDecodeTime
        if (version === 0){
            const base_media_decode_time = be4toi(input, 12);
            new_base_media_decode_time = base_media_decode_time + tfdt_offset;
            if (new_base_media_decode_time < 4294967296){
                output = concat(output,input.subarray(0,12));
                output = concat(output, itobe4(new_base_media_decode_time));
            } else {
                // Forced to change to 64-bit tfdt.
                this.size_change = 4;
                output = concat(output, itobe4(be4toi(input, 0) + this.size_change));
                output = concat(output, input.subarray(4,8));
                output = concat(output, strToBytes(chr(1)));
                output = concat(output, input.subarray(9, 12));
                output = concat(output, itobe8(new_base_media_decode_time));
            }
        }
        // 64-bit
        else {
          output = concat(output, input.subarray(0,12));
          const base_media_decode_time = be8toi(input, 12);
          new_base_media_decode_time = base_media_decode_time + tfdt_offset;
          output = concat(output, itobe8(new_base_media_decode_time));
        }
        this.tfdt_value = new_base_media_decode_time;
        return output;
      }

      /**
       * Generate new timestamps for tfdt and change size of boxes above if needed.
       * Note that the input output will be returned and can have another size.
       */
      tfdt_64bit(
        input: Uint8Array,
        _output: Uint8Array
      ){
        const version = ord(input[8].toString());
        const tfdt_offset = this.offset*this.track_timescale;
        let output = _output;
        let base_media_decode_time;
        // 32-bit baseMediaDecodeTime
        if(version === 0){
          this.size_change = 4;
          output = concat(output, itobe4(be4toi(input, 0) + this.size_change));
          output = concat(output, input.subarray(4,8));
          output = concat(output, strToBytes(chr(1)));
          output = concat(output, input.subarray(9, 12));
          base_media_decode_time = be4toi(input, 12);
        }
        // 64-bit
        else{
          output = input.subarray(0,12);
          base_media_decode_time = be8toi(input, 12);
        }
        const new_base_media_decode_time = base_media_decode_time + tfdt_offset;
        output = concat(output, itobe8(new_base_media_decode_time));
        this.tfdt_value = new_base_media_decode_time;
        return output;
      }

      /**
       * Update the ttml payload of mdat and its size.
       */
      update_ttml_mdat(data: Uint8Array){
        const ttml_xml = data.subarray(8, data.length);
        const ttml_out = adjust_ttml_content(ttml_xml, this.offset, this.seg_nr);
        this.ttml_size = ttml_out.length;
        const out_size = this.ttml_size + 8;
        return concat(itobe4(out_size), strToBytes("mdat"), strToBytes(ttml_out));
      }

      /**
       * Change the ttml part of mdat and update mdat size. Return full new data.
       */
      find_and_process_mdat(
        data: Uint8Array,
        offset: number,
        seg_nr: number
      ){
        let pos = 0;
        let output = new Uint8Array(0);
        while (pos < data.length){
            const size = be4toi(data, pos);
            const boxtype = bytesToStr(data.subarray(pos+4,pos+8));
            const input_for_update =
              boxtype !== "mdat" ?
                data.subarray(pos, pos+size) :
                this.update_ttml_mdat(data.subarray(pos, pos+size));
            output = concat(output, input_for_update);
            pos += size;
        }
        return output;
      }
    }
