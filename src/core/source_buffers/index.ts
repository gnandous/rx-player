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

import MediaError from "../../errors/MediaError";
import log from "../../utils/log";
import { SupportedBufferTypes } from "../types";
import { ICustomSourceBuffer } from "./abstract_source_buffer";
import ImageSourceBuffer from "./image";
import QueuedSourceBuffer from "./queued_source_buffer";
import {
  HTMLTextSourceBuffer,
  NativeTextSourceBuffer,
} from "./text";
import ICustomTimeRanges from "./time_ranges";

export type SourceBufferOptions =
  {
    textTrackMode? : "native";
    hideNativeSubtitle? : boolean;
  } |
  {
    textTrackMode : "html";
    textTrackElement : HTMLElement;
  };

type INativeSourceBufferType = "audio" | "video";

interface ICreatedSourceBuffer<T> {
  codec : string;
  sourceBuffer : QueuedSourceBuffer<T>;
}

type ICreatedNativeSourceBuffer =
  ICreatedSourceBuffer<ArrayBuffer|ArrayBufferView>;

/**
 * Adds a SourceBuffer to the MediaSource.
 * @param {MediaSource} mediaSource
 * @param {string} codec
 * @returns {SourceBuffer}
 */
function createNativeQueuedSourceBuffer(
  mediaSource : MediaSource,
  codec : string
) : QueuedSourceBuffer<ArrayBuffer|ArrayBufferView> {
  const sourceBuffer = mediaSource.addSourceBuffer(codec);
  return new QueuedSourceBuffer(sourceBuffer);
}

/**
 * Allows to easily create and dispose SourceBuffers.
 *
 * Only one source buffer per type is allowed at the same time:
 *
 *   - source buffers for native types (which depends on the native
 *     SourceBuffer implementation), are reused if one is re-created.
 *
 *   - source buffers for custom types are aborted each time a new one of the
 *     same type is created.
 *
 * The returned SourceBuffer is actually a QueuedSourceBuffer instance which
 * wrap a SourceBuffer implementation to queue all its actions.
 *
 * @class SourceBufferManager
 */
export default class SourceBufferManager {
  /**
   * Returns true if the source buffer is "native" (has to be attached to the
   * mediaSource at the beginning of the stream.
   * @static
   * @param {string} bufferType
   * @returns {Boolean}
   */
  static isNative(bufferType : string) : bufferType is INativeSourceBufferType {
    return shouldHaveNativeSourceBuffer(bufferType);
  }

  private _videoElement : HTMLMediaElement;
  private _mediaSource : MediaSource;

  private _initializedNativeSourceBuffers : {
    audio? : ICreatedNativeSourceBuffer;
    video? : ICreatedNativeSourceBuffer;
  };

  private _initializedCustomSourceBuffers : {
    text? : ICreatedSourceBuffer<any>;
    image? : ICreatedSourceBuffer<any>;
  };

  /**
   * @param {HTMLMediaElement} videoElement
   * @param {MediaSource} mediaSource
   * @constructor
   */
  constructor(videoElement : HTMLMediaElement, mediaSource : MediaSource) {
    this._videoElement = videoElement;
    this._mediaSource = mediaSource;
    this._initializedNativeSourceBuffers = {};
    this._initializedCustomSourceBuffers = {};
  }

  /**
   * Creates a new QueuedSourceBuffer for the given buffer type.
   * @param {string} bufferType
   * @param {string} codec
   * @param {Object} [options={}]
   * @returns {QueuedSourceBuffer}
   */
  createSourceBuffer(
    bufferType : SupportedBufferTypes,
    codec : string,
    options : SourceBufferOptions = {}
  ) : QueuedSourceBuffer<any> {
    if (shouldHaveNativeSourceBuffer(bufferType)) {
      const memorizedSourceBuffer = this._initializedNativeSourceBuffers[bufferType];
      if (memorizedSourceBuffer) {
        if (memorizedSourceBuffer.codec !== codec) {
          log.info(
            "reusing native SourceBuffer with codec", memorizedSourceBuffer.codec,
            "for codec", codec
          );
        } else {
          log.info("reusing native SourceBuffer with codec", codec);
        }
        return memorizedSourceBuffer.sourceBuffer;
      }
      log.info("adding native SourceBuffer with codec", codec);
      const nativeSourceBuffer = createNativeQueuedSourceBuffer(this._mediaSource, codec);
      this._initializedNativeSourceBuffers[bufferType] = {
        codec,
        sourceBuffer: nativeSourceBuffer,
      };
      return nativeSourceBuffer;
    }

    const memorizedCustomSourceBuffer = this
      ._initializedCustomSourceBuffers[bufferType];

    if (memorizedCustomSourceBuffer) {
      log.info("aborting a previous custom SourceBuffer for the type", bufferType);
      try {
        memorizedCustomSourceBuffer.sourceBuffer.abort();
      } catch (e) {
        log.warn("failed to abort a SourceBuffer:", e);
      }
      delete this._initializedCustomSourceBuffers[bufferType];
    }

    if (bufferType === "text") {
      log.info("creating a new text SourceBuffer with codec", codec);

      const sourceBuffer = options.textTrackMode === "html" ?
        new HTMLTextSourceBuffer(codec, this._videoElement, options.textTrackElement) :
        new NativeTextSourceBuffer(codec, this._videoElement, options.hideNativeSubtitle);
      const queuedSourceBuffer = new QueuedSourceBuffer(sourceBuffer);

      this._initializedCustomSourceBuffers.text = {
        codec,
        sourceBuffer: queuedSourceBuffer,
      };
      return queuedSourceBuffer;
    } else if (bufferType === "image") {
      log.info("creating a new image SourceBuffer with codec", codec);
      const sourceBuffer = new ImageSourceBuffer(codec);
      const queuedSourceBuffer = new QueuedSourceBuffer(sourceBuffer);
      this._initializedCustomSourceBuffers.image = {
        codec,
        sourceBuffer: queuedSourceBuffer,
      };
      return queuedSourceBuffer;
    }

    log.error("unknown buffer type:", bufferType);
    throw new MediaError("BUFFER_TYPE_UNKNOWN", null, true);
  }

  /**
   * Dispose of the active SourceBuffer for the given type.
   * @param {string} bufferType
   */
  dispose(bufferType : SupportedBufferTypes) : void {
    if (shouldHaveNativeSourceBuffer(bufferType)) {
      const memorizedNativeSourceBuffer = this
        ._initializedNativeSourceBuffers[bufferType];

      if (!memorizedNativeSourceBuffer) {
        return;
      }

      log.info("aborting native source buffer", bufferType);
      try {
        memorizedNativeSourceBuffer.sourceBuffer.abort();
      } catch (e) {
        log.warn("failed to abort a SourceBuffer:", e);
      }
      delete this._initializedNativeSourceBuffers[bufferType];
      return;
    } else if (bufferType === "text" || bufferType === "image") {
      const memorizedSourceBuffer = this
        ._initializedCustomSourceBuffers[bufferType];

      if (!memorizedSourceBuffer) {
        return;
      }

      log.info("aborting custom source buffer", bufferType);
      try {
        memorizedSourceBuffer.sourceBuffer.abort();
      } catch (e) {
        log.warn("failed to abort a SourceBuffer:", e);
      }
      delete this._initializedCustomSourceBuffers[bufferType];
      return;
    }

    log.error("cannot dispose an unknown buffer type", bufferType);
  }

  /**
   * Dispose of all QueuedSourceBuffer created on this SourceBufferManager.
   * TODO better code?
   */
  disposeAll() {
    this.dispose("audio");
    this.dispose("video");
    this.dispose("text");
    this.dispose("image");
  }
}

/**
 * Returns true if the given buffeType is a native buffer, false otherwise.
 * "Native" source buffers are directly added to the MediaSource.
 * @param {string} bufferType
 * @returns {Boolean}
 */
function shouldHaveNativeSourceBuffer(
  bufferType : string
) : bufferType is INativeSourceBufferType {
  return bufferType === "audio" || bufferType === "video";
}

export {
  ICustomSourceBuffer,
  ICustomTimeRanges,
  QueuedSourceBuffer,
};
