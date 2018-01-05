# Period Buffers

## Overview

The DASH transport protocol has a concept called _Period_. Simply put, it allows to set various types of content successively in the same manifest.

For example, you could have a manifest describing a live content with chronologically:
 - an english TV Show
 - an old italian film with subtitles
 - an American film with closed captions.

Example:
```
08h05              09h00                       10h30                now
  |==================|===========================|===================|
        TV Show               Italian Film            American film
```

Those contents are drastically differents (they have different languages, the american film might have more available bitrates than the old italian one).

Moreover, even a library user might want to be able to know when the italian film is finished, to report about it immediately in a graphical interface.

As such, they have to be considered separately, as periods:
```
        Period 1                Period 2                Period 3
08h05              09h00                       10h30                now
  |==================|===========================|===================|
        TV Show               Italian Film            American film
```

To manage optimally this complex but common usecase, a new concept has been put in place in the RxPlayer: _Period Buffers_.

_Period Buffers_ are automatically created/destroyed during playback. The job of a single _Period Buffer_ is to process and download optimally the content linked to a single _Period_:
```
      PERIOD BUFFER
08h05              09h00
  |=========         |
        TV Show
```


To allow smooth transitions between them, we also might want to preload content defined by a subsequent _Period_ once we lean towards the end of the content described by the previous one. Thus, multiple _Period Buffers_ might be active at the same time:

```
     PERIOD BUFFER 1        PERIOD BUFFER 2         PERIOD BUFFER 3
08h05              09h00                       10h30                now
  |=============     |=================          |================   |
        TV Show               Italian Film            American film
```

## Implementation

The Stream entirely manages those _Period Buffers_.

Each of these are created for a single type of buffers (e.g. _video_, _text_ or _audio_ content). Which means that for a _Period_ having those three types of content, three _Period Buffers_ will be created:

```
+----------------------------   AUDIO   ----------------------------------+
|                                                                         |
|      PERIOD BUFFER 1        PERIOD BUFFER 2         PERIOD BUFFER 3     | 
| 08h05              09h00                       10h30                now |
|   |=============     |=================          |================   |  |
|         TV Show               Italian Film            American film     |
+-------------------------------------------------------------------------+  

+------------------------------   VIDEO   --------------------------------+
|                                                                         |
|      PERIOD BUFFER 1        PERIOD BUFFER 2         PERIOD BUFFER 3     |
| 08h05              09h00                       10h30                now |
|   |=====             |===                        |===                |  |
|         TV Show               Italian Film            American film     |
+-------------------------------------------------------------------------+

+------------------------------   TEXT   ---------------------------------+
|                                                                         |
|      PERIOD BUFFER 1        PERIOD BUFFER 2         PERIOD BUFFER 3     |
| 08h05              09h00                       10h30                now |
|     (NO SUBTITLES)   |=========================  |=================  |  |
|         TV Show               Italian Film            American film     |
+-------------------------------------------------------------------------+
```
_Note: Behind the scene, those Period Buffers rely mainly on RxPlayer's Buffers to download content_

The creation/destruction of _Period Buffers_ by the Stream is actually done in a very precize and optimal way, which gives a higher priority to immediate content.

To better grasp how it works, let's imagine a regular use-case, with two periods for a single type of Buffer:

Let's say that the _Period Buffer_ for the first _Period_ (named P1) is currently
actively downloading segments (the "^" sign is the current position):
```
   P1
|====  |
   ^
```

Once P1 is full (it has no segment left to download):
```
   P1
|======|
   ^
```

We will be able to create a new _Period Buffer_, P2, for the second _Period_:
```
   P1     P2
|======|      |
   ^
```

Which will then also download segments:
```
   P1     P2
|======|==    |
   ^
```

If P1 needs segments again however (e.g. we change the bitrate, the
language etc.):
```
   P1     P2
|===   |==    |
   ^
```

Then we will destroy P2, to keep it from downloading segments:
```
   P1
|===   |
   ^
```

----

Once P1, goes full again, we still have the segment pushed to P2 available:
```
   P1     P2
|======|==    |
   ^
```
_Note: Of course, if the segments previously downloaded by P2 are not in the
wanted user settings (example: the language has been switched since then),
those segments will be re-downloaded._

When the current position go ahead of a _Period Buffer_ (here ahead of P1):
```
   P1     P2
|======|===   |
        ^
```

This _Period Buffer_ is destroyed to free up ressources:
```
          P2
       |===   |
        ^
```

----

When the current position goes behind the first currently defined _Period Buffer_:
```
          P2
       |===   |
    ^
```

Then we destroy all previous _Period Buffers_ and [re-]create the one needed:
```
   P1
|======|
    ^
```

In this example, P1 is full so we also can re-create P2, which will also keep
its already-pushed segments:
```
   P1     P2
|======|===   |
    ^
```

----

For multiple types of Buffers (example: _audio_ and _video_) the same logic is repeated (and separated) as many times. An _audio_ _Period Buffer_ will not influence a _video_ one:
```
---------------------------   AUDIO   --------------------------------
        P1               P2     
|================|=============   |
     ^

---------------------------   VIDEO   --------------------------------
        P1       
|=======         |
     ^

----------------------------   TEXT   --------------------------------
        P1                                 B3
|================| (NO SUBTITLES) |================   |
     ^
```

At the end, we should only have _Period Buffer[s]_ for consecutive Period[s]:
  - The first chronological one is the one currently seen by the user.
  - The last chronological one is the only one downloading content.
  - In between, we only have full consecutive _Period Buffers_.

## Communication with the API

The Stream communicates to the API about creations and destructions of _Period Buffers_ respectively through ``"periodBufferReady"`` and ``"periodBufferCleared"`` events.

In the RxPlayer, the API will then keep track of which _Period Buffer_ is currently created, for which type of buffer. This facilitates:
  - language switching on audio and text contents for any created _Period Buffer_.
  - reporting of it to the library user.

```
  +-----------+            API MEMORY
  |           |           ------------  
  |           |
  |           |  Period     Audio  Video  Text
  |    API    |  ------------------------------
  |           |  Period 1     X      X     X    <--- cleared
  |           |  Period 2     O      O     X    <--- current one
  |           |  Period 3     X      O     O    <--- next one
  +-----------+
        ^      
        |
        |                                             +--------------+
        +-------------------------------------------- |              |
     |    "periodBufferReady" for video period 1      |              |
     |    "periodBufferReady" for audio period 2      |              |
     |    "periodBufferReady" for audio period 2      |              |
     |    "periodBufferCleared" for video period 1    |    STREAM    |
     |    "periodBufferReady" for video period 3      |              |
     V    "periodBufferReady" for text period 3       |              |
                                                      |              |
                      ---------------                 |              |
                       STREAM EVENTS                  +--------------+
                                                   
```
