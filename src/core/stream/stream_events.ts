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

import { Subject } from "rxjs/Subject";
import Manifest, {
  Adaptation,
  Period,
} from "../../manifest";
import ABRManager from "../abr";
import {
  IAdaptationBufferEvent,
  IRepresentationChangeEvent,
} from "../buffer";
import { ISessionEvent } from "../eme/session";
import { SupportedBufferTypes } from "../types";
import { IStallingItem } from "./stalling_manager";

export interface IAdaptationChangeEvent {
  type : "adaptationChange";
  value : {
    type : SupportedBufferTypes;
    adaptation : Adaptation|null;
  };
}

// Subjects given to allow a choice between the different adaptations available
// export type IAdaptationsSubject = Partial<
//   Record<SupportedBufferTypes, ReplaySubject<Adaptation|null>>
// >;

export interface IStreamStartedEvent {
  type : "started";
  value : {
    abrManager : ABRManager;
    manifest : Manifest;
  };
}

export interface IManifestUpdateEvent {
  type : "manifestUpdate";
  value : {
    manifest : Manifest;
  };
}

export interface ISpeedChangedEvent {
  type : "speed";
  value : number;
}

export interface IStalledEvent {
  type : "stalled";
  value : IStallingItem|null;
}

export interface IStreamLoadedEvent {
  type : "loaded";
  value : true;
}

export interface IPeriodChangeEvent {
  type : "periodChange";
  value : {
    period : Period;
  };
}

export interface IPreparePeriodEvent {
  type : "periodReady";
  value : {
    type : SupportedBufferTypes;
    period : Period;
    adaptation$ : Subject<Adaptation|null>;
  };
}

export interface IFinishedPeriodEvent {
  type : "finishedPeriod";
  value : {
    type : SupportedBufferTypes;
    period : Period;
  };
}

const STREAM_EVENTS = {
  adaptationChange(
    bufferType : SupportedBufferTypes,
    adaptation : Adaptation|null
  ) : IAdaptationChangeEvent {
    return {
      type: "adaptationChange",
      value : {
        type: bufferType,
        adaptation,
      },
    };
  },

  loaded() : IStreamLoadedEvent {
    return {
      type: "loaded",
      value: true,
    };
  },

  started(abrManager : ABRManager, manifest : Manifest) : IStreamStartedEvent {
    return {
      type: "started",
      value: {
        abrManager,
        manifest,
      },
    };
  },

  manifestUpdate(manifest : Manifest) : IManifestUpdateEvent {
    return {
      type: "manifestUpdate",
      value: {
        manifest,
      },
    };
  },

  speedChanged(speed : number) : ISpeedChangedEvent {
    return {
      type: "speed",
      value: speed,
    };
  },

  stalled(stalling : IStallingItem|null) : IStalledEvent {
    return {
      type: "stalled",
      value: stalling,
    };
  },

  periodChange(period : Period) : IPeriodChangeEvent {
    return {
      type : "periodChange",
      value : {
        period,
      },
    };
  },

  nullRepresentation(type : SupportedBufferTypes) : IRepresentationChangeEvent {
    return {
      type: "representationChange",
      value: {
        type,
        representation: null,
      },
    };
  },

  periodReady(
    type : SupportedBufferTypes,
    period : Period,
    adaptation$ : Subject<Adaptation|null>
  ) : IPreparePeriodEvent {
    return {
      type: "periodReady",
      value: {
        type,
        period,
        adaptation$,
      },
    };
  },

  finishedPeriod(
    type : SupportedBufferTypes,
    period : Period
  ) : IFinishedPeriodEvent {
    return {
      type: "finishedPeriod",
      value: {
        type,
        period,
      },
    };
  },
};

// Every possible item emitted by the Stream
export type IStreamEvent =
  IAdaptationBufferEvent |
  IAdaptationChangeEvent |
  IFinishedPeriodEvent |
  IManifestUpdateEvent |
  IPeriodChangeEvent |
  IPreparePeriodEvent |
  ISessionEvent |
  ISpeedChangedEvent |
  IStalledEvent |
  IStreamLoadedEvent |
  IStreamStartedEvent;

export default STREAM_EVENTS;
