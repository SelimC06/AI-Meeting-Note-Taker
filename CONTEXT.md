# DeskRecap

A local-first desktop app that records or imports meetings, transcribes them, and turns them into notes you can read, search and chat with.

## Language

### Meetings

**Meeting**:
The unit a user records or imports and later reads, chats with and exports.
_Avoid_: Session, call, recording (for the whole unit)

**Recording**:
The captured media of one meeting. An imported meeting is one whose recording came from a file.
_Avoid_: Session, capture (for the saved media)

**Import**:
A meeting created from an existing audio or video file instead of being recorded in the app.
_Avoid_: Upload

### Speakers

**Speaker**:
A distinct voice within one meeting.
_Avoid_: Participant, person (when only the voice is known)

**Speaker label**:
The raw tag the system assigns a speaker before anyone names it, such as `SPEAKER_01`, "You" or "Others".
_Avoid_: Speaker ID, raw speaker

**Voice profile**:
A named identity that persists across meetings, learned whenever a user names a speaker, and used to name matching speakers automatically in later meetings.
_Avoid_: Speaker profile, voiceprint, enrollment
