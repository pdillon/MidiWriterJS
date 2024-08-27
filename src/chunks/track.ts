import { AbstractEvent } from '../abstract-event';
import {Chunk} from './chunk';
import {Constants} from '../constants';
import {ControllerChangeEvent} from '../midi-events/controller-change-event';
import {CopyrightEvent} from '../meta-events/copyright-event';
import {CuePointEvent} from '../meta-events/cue-point-event';
import {EndTrackEvent} from '../meta-events/end-track-event';
import {InstrumentNameEvent} from '../meta-events/instrument-name-event';
import {KeySignatureEvent} from '../meta-events/key-signature-event';
import {LyricEvent} from '../meta-events/lyric-event';
import {MarkerEvent} from '../meta-events/marker-event';
import {NoteEvent} from '../midi-events/note-event';
import {NoteOnEvent} from '../midi-events/note-on-event';
import {NoteOffEvent} from '../midi-events/note-off-event';
import {PitchBendEvent} from '../midi-events/pitch-bend-event';
import {TempoEvent} from '../meta-events/tempo-event';
import {TextEvent} from '../meta-events/text-event';
import {TimeSignatureEvent} from '../meta-events/time-signature-event';
import {TrackNameEvent} from '../meta-events/track-name-event';
import {Utils} from '../utils';

/**
 * Holds all data for a track.
 * @param {object} fields {type: number, data: array, size: array, events: array}
 * @return {Track}
 */
class Track implements Chunk {
	data: number[];
	events: AbstractEvent[];
	explicitTickEvents: NoteEvent[];
	size: number[];
	type: number[];
	tickPointer: number;

	constructor() {
		this.type = Constants.TRACK_CHUNK_TYPE;
		this.data = [];
		this.size = [];
		this.events = [];
		this.explicitTickEvents = [];

		// If there are any events with an explicit tick defined then we will create a "sub" track for those
		// and merge them in and the end.
		this.tickPointer = 0; // Each time an event is added this will increase
	}

	/**
	 * Adds any event type to the track.
	 * Events without a specific startTick property are assumed to be added in order of how they should output.
	 * Events with a specific startTick property are set aside for now will be merged in during build process.
	 *
	 * TODO: Don't put startTick events in their own array.  Just lump everything together and sort it out during buildData();
	 * @param {(NoteEvent|ProgramChangeEvent)} events - Event object or array of Event objects.
	 * @param {Function} mapFunction - Callback which can be used to apply specific properties to all events.
	 * @return {Track}
	 */
	addEvent(events: (AbstractEvent|AbstractEvent[]), mapFunction?: (i: number, event: AbstractEvent) => object): Track {
		Utils.toArray(events).forEach((event, i) => {
			if (event instanceof NoteEvent && typeof mapFunction === 'function') {
				const properties = mapFunction(i, event);
				if (typeof properties === 'object') {
					Object.assign(event, properties);
				}
			} 
			
			// If this event has an explicit startTick then we need to set aside for now
			if (event.tick !== null) {
				this.explicitTickEvents.push(event);

			} else if (event instanceof NoteEvent) {
				// Push each on/off event to track's event stack
				event.buildData().events.forEach((e) => this.events.push(e));
			}
			else {
				this.events.push(event);
			}
		});

		return this;
	}

	/**
	 * Builds int array of all events.
	 * @param {object} options
	 * @return {Track}
	 */
	buildData(options = {}) {
		// Reset
		this.data = [];
		this.size = [];
		this.tickPointer = 0;

		let precisionLoss = 0;

		this.events.forEach((event) => {
			// Build event & add to total tick duration
			if (event instanceof NoteOnEvent || event instanceof NoteOffEvent) {
				const built = event.buildData(this, precisionLoss, options);
				precisionLoss = Utils.getPrecisionLoss(event.deltaWithPrecisionCorrection || 0);
				this.data = this.data.concat(built.data);
				this.tickPointer = Utils.getRoundedIfClose(event.tick);

			} else if (event instanceof TempoEvent) {
				this.tickPointer = Utils.getRoundedIfClose(event.tick);
				this.data = this.data.concat(event.data);

			} else {
				this.data = this.data.concat(event.data);
			}
		});

		this.mergeExplicitTickEvents();

		// If the last event isn't EndTrackEvent, then tack it onto the data.
		if (!this.events.length || !(this.events[this.events.length - 1] instanceof EndTrackEvent)) {
			this.data = this.data.concat((new EndTrackEvent).data);
		}

		this.size = Utils.numberToBytes(this.data.length, 4); // 4 bytes long
		return this;
	}

	mergeExplicitTickEvents() {
		if (!this.explicitTickEvents.length) return;

		// First sort asc list of events by startTick
		this.explicitTickEvents.sort((a, b) => a.tick - b.tick);

		// Now this.explicitTickEvents is in correct order, and so is this.events naturally.
		// For each explicit tick event, splice it into the main list of events and
		// adjust the delta on the following events so they still play normally.
		this.explicitTickEvents.forEach((midiEvent: NoteEvent | TempoEvent) => {
			// Convert NoteEvent to it's respective NoteOn/NoteOff events
			// Note that as we splice in events the delta for the NoteOff ones will
			// Need to change based on what comes before them after the splice.
			if (midiEvent instanceof NoteEvent) {
				midiEvent.buildData().events.forEach((e) => e.buildData(this));

				// Merge each event individually into this track's event list.
				midiEvent.events.forEach((event) => this.mergeSingleEvent(event));
			} else if (midiEvent instanceof TempoEvent) {
				this.mergeSingleEvent(midiEvent);
				midiEvent.buildData();
			}
			else {
			 	this.mergeSingleEvent(midiEvent);
			}
			
		});

		// Hacky way to rebuild track with newly spliced events.  Need better solution.
		this.explicitTickEvents = [];
		this.buildData();
	}

	/**
	 * Merges another track's events with this track.
	 * @param {Track} track
	 * @return {Track}
	 */
	mergeTrack(track: Track): Track {
		// First build this track to populate each event's tick property
		this.buildData();

		// Then build track to be merged so that tick property is populated on all events & merge each event.
		track.buildData().events.forEach((event) => this.mergeSingleEvent(event));
		return this;
	}

	/**
	 * Merges a single event into this track's list of events based on event.tick property.
	 * @param {AbstractEvent} - event
	 * @return {Track}
	 */
	mergeSingleEvent(event: AbstractEvent): Track {
		// There are no events yet, so just add it in.
		if (!this.events.length) {
			if (event.tick !== null) {
				this.events.push(event);
			} else {
				this.addEvent(event);
			}
			return;
		}

		// Find index of existing event we need to follow with
		let lastEventIndex;

		for (let i = 0; i < this.events.length; i++) {
			if (this.events[i].tick === event.tick && this.events[i] instanceof TempoEvent) {
				// If this event is a tempo event and it falls on the same tick as the event we're trying to merge
				// then we need to splice it in at this point.
				lastEventIndex = i;
				break;
			}

			if (this.events[i].tick > event.tick) break;
			lastEventIndex = i;
		}

		const splicedEventIndex = lastEventIndex + 1;

		// Need to adjust the delta of this event to ensure it falls on the correct tick.
		event.delta = event.tick - this.events[lastEventIndex].tick;

		// Splice this event at lastEventIndex + 1
		this.events.splice(splicedEventIndex, 0, event);

		// Now adjust delta of all following events
		for (let i = splicedEventIndex + 1; i < this.events.length; i++) {
			// Since each existing event should have a tick value at this point we just need to
			// adjust delta to that the event still falls on the correct tick.
			this.events[i].delta = this.events[i].tick - this.events[i - 1].tick;
		}
	}

	/**
	 * Removes all events matching specified type.
	 * @param {string} eventName - Event type
	 * @return {Track}
	 */
	removeEventsByName(eventName: string): Track {
		this.events.forEach((event, index) => {
			if (event.name === eventName) {
				this.events.splice(index, 1);
			}
		});

		return this;
	}

	/**
	 * Sets tempo of the MIDI file.
	 * @param {number} bpm - Tempo in beats per minute.
	 * @param {number} tick - Start tick.
	 * @return {Track}
	 */
	setTempo(bpm: number, tick = 0): Track {
		return this.addEvent(new TempoEvent({bpm, tick}));
	}

	/**
	 * Sets time signature.
	 * @param {number} numerator - Top number of the time signature.
	 * @param {number} denominator - Bottom number of the time signature.
	 * @param {number} midiclockspertick - Defaults to 24.
	 * @param {number} notespermidiclock - Defaults to 8.
	 * @return {Track}
	 */
	setTimeSignature(numerator: number, denominator: number, midiclockspertick: number, notespermidiclock: number): Track {
		return this.addEvent(new TimeSignatureEvent(numerator, denominator, midiclockspertick, notespermidiclock));
	}

	/**
	 * Sets key signature.
	 * @param {*} sf -
	 * @param {*} mi -
	 * @return {Track}
	 */
	setKeySignature(sf, mi) {
		return this.addEvent(new KeySignatureEvent(sf, mi));
	}

	/**
	 * Adds text to MIDI file.
	 * @param {string} text - Text to add.
	 * @return {Track}
	 */
	addText(text: string): Track {
		return this.addEvent(new TextEvent({text}));
	}

	/**
	 * Adds copyright to MIDI file.
	 * @param {string} text - Text of copyright line.
	 * @return {Track}
	 */
	addCopyright(text: string): Track {
		return this.addEvent(new CopyrightEvent({text}));
	}

	/**
	 * Adds Sequence/Track Name.
	 * @param {string} text - Text of track name.
	 * @return {Track}
	 */
	addTrackName(text: string): Track {
		return this.addEvent(new TrackNameEvent({text}));
	}

	/**
	 * Sets instrument name of track.
	 * @param {string} text - Name of instrument.
	 * @return {Track}
	 */
	addInstrumentName(text: string): Track {
		return this.addEvent(new InstrumentNameEvent({text}));
	}

	/**
	 * Adds marker to MIDI file.
	 * @param {string} text - Marker text.
	 * @return {Track}
	 */
	addMarker(text: string): Track {
		return this.addEvent(new MarkerEvent({text}));
	}

	/**
	 * Adds cue point to MIDI file.
	 * @param {string} text - Text of cue point.
	 * @return {Track}
	 */
	addCuePoint(text: string): Track {
		return this.addEvent(new CuePointEvent({text}));
	}

	/**
	 * Adds lyric to MIDI file.
	 * @param {string} text - Lyric text to add.
	 * @return {Track}
	 */
	addLyric(text: string): Track {
		return this.addEvent(new LyricEvent({text}));
	}

	/**
	 * Channel mode messages
	 * @return {Track}
	 */
	polyModeOn(): Track {
		const event = new NoteOnEvent({data: [0x00, 0xB0, 0x7E, 0x00]});
		return this.addEvent(event);
	}


	/**
	 * Sets a pitch bend.
	 * @param {float} bend - Bend value ranging [-1,1], zero meaning no bend.
	 * @return {Track}
	 */
	setPitchBend(bend: number): Track {
		return this.addEvent(new PitchBendEvent({bend}));
	}


	/**
	 * Adds a controller change event
	 * @param {number} number - Control number.
	 * @param {number} value - Control value.
	 * @param {number} channel - Channel to send controller change event on (1-based).
	 * @param {number} delta - Track tick offset for cc event.
	 * @return {Track}
	 */
	controllerChange(number: number, value: number, channel?: number, delta?: number): Track {
		return this.addEvent(new ControllerChangeEvent({controllerNumber: number, controllerValue: value, channel: channel, delta: delta}));
	}

}

export {Track};
