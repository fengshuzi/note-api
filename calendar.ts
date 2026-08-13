import { execFile } from 'child_process';
import { Platform } from 'obsidian';

// macOS Calendar access via JXA/EventKit, ported from lite-calendar
// (src/storage.ts). Unlike the plugin version this layer never shows
// Notices — failures are thrown so the HTTP handler can return them.

export interface CalendarEventItem {
	id: string;
	title: string;
	calendar: string;
	start: string;
	end: string;
	allDay: boolean;
	location?: string;
	notes?: string;
}

const EXEC_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

const execAsync = (script: string, options: { timeout: number }): Promise<string> => {
	return new Promise<string>((resolve, reject) => {
		// execFile with args (not exec + string) so event titles etc. can
		// never break out of the shell quoting.
		execFile('osascript', ['-l', 'JavaScript', '-e', script], { ...options, maxBuffer: EXEC_MAX_BUFFER_BYTES }, (err: unknown, stdout: unknown) => {
			if (err) {
				reject(err instanceof Error ? err : new Error(String(err)));
				return;
			}
			resolve(typeof stdout === 'string' ? stdout : String(stdout));
		});
	});
};

function assertMacOS() {
	if (!Platform.isMacOS) {
		throw new Error('Calendar API is only available on macOS');
	}
}

async function runJXA(script: string): Promise<string | null> {
	assertMacOS();
	try {
		const stdout = await execAsync(script, { timeout: 60000 });
		return stdout.trim();
	} catch (error: unknown) {
		const msg = error instanceof Error ? error.message : String(error);
		console.error('[note-api] Calendar JXA error:', msg);
		throw new Error(`Calendar operation failed: ${msg}`);
	}
}

function escapeJXA(str: string): string {
	return str
		.replace(/\\/g, '\\\\')
		.replace(/"/g, '\\"')
		.replace(/\n/g, '\\n');
}

// Shared prelude: import EventKit, create a store, request access (entity
// type 0 = events) if not yet authorized.
const JXA_PRELUDE = 'ObjC.import("EventKit");var store=$.EKEventStore.alloc.init;var status=$.EKEventStore.authorizationStatusForEntityType(0);if(status!=3){store.requestAccessToEntityTypeCompletion(0,null);delay(2);}';

export async function listCalendarEvents(startISO: string, endISO: string): Promise<CalendarEventItem[]> {
	const script = `${JXA_PRELUDE}var start=$.NSDate.dateWithTimeIntervalSince1970(new Date("${escapeJXA(startISO)}").getTime()/1000);var end=$.NSDate.dateWithTimeIntervalSince1970(new Date("${escapeJXA(endISO)}").getTime()/1000);var cals=store.calendarsForEntityType(0);var predicate=store.predicateForEventsWithStartDateEndDateCalendars(start,end,cals);var allEvents=store.eventsMatchingPredicate(predicate);var result=[];for(var i=0;i<allEvents.count;i++){var e=allEvents.objectAtIndex(i);result.push({title:ObjC.unwrap(e.title),id:ObjC.unwrap(e.calendarItemIdentifier),calendar:ObjC.unwrap(e.calendar.title),start:ObjC.unwrap(e.startDate).toISOString(),end:ObjC.unwrap(e.endDate).toISOString(),allDay:e.isAllDay,location:e.location?ObjC.unwrap(e.location):null,notes:e.notes?ObjC.unwrap(e.notes):null});}result.sort(function(a,b){return new Date(a.start)-new Date(b.start);});JSON.stringify(result);`;

	const result = await runJXA(script);
	if (!result) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(result);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const events: CalendarEventItem[] = [];
	for (const item of parsed) {
		if (item === null || typeof item !== 'object') continue;
		const obj = item as Record<string, unknown>;
		if (typeof obj.id !== 'string' || typeof obj.title !== 'string') continue;
		if (typeof obj.start !== 'string' || typeof obj.end !== 'string') continue;
		const event: CalendarEventItem = {
			id: obj.id,
			title: obj.title,
			calendar: typeof obj.calendar === 'string' ? obj.calendar : '',
			start: obj.start,
			end: obj.end,
			allDay: obj.allDay === true,
		};
		if (typeof obj.location === 'string' && obj.location) event.location = obj.location;
		if (typeof obj.notes === 'string' && obj.notes) event.notes = obj.notes;
		events.push(event);
	}
	return events;
}

export async function listCalendarNames(): Promise<string[]> {
	const script = `${JXA_PRELUDE}var cals=store.calendarsForEntityType(0);var result=[];for(var i=0;i<cals.count;i++){result.push(ObjC.unwrap(cals.objectAtIndex(i).title));}JSON.stringify(result);`;
	const result = await runJXA(script);
	if (!result) return [];
	try {
		const parsed: unknown = JSON.parse(result);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((name): name is string => typeof name === 'string');
	} catch {
		return [];
	}
}

export async function createCalendarEvent(
	calendarName: string,
	title: string,
	startISO: string,
	endISO: string,
): Promise<void> {
	const script = `${JXA_PRELUDE}var cals=store.calendarsForEntityType(0);var targetCal=null;for(var i=0;i<cals.count;i++){var cal=cals.objectAtIndex(i);if(ObjC.unwrap(cal.title)==="${escapeJXA(calendarName)}"){targetCal=cal;break;}}if(!targetCal){targetCal=store.defaultCalendarForNewEvents;}if(!targetCal){"no writable calendar";}else{var event=$.EKEvent.eventWithEventStore(store);event.title=$("${escapeJXA(title)}");event.startDate=$.NSDate.dateWithTimeIntervalSince1970(new Date("${escapeJXA(startISO)}").getTime()/1000);event.endDate=$.NSDate.dateWithTimeIntervalSince1970(new Date("${escapeJXA(endISO)}").getTime()/1000);event.calendar=targetCal;var error=$();store.saveEventSpanCommitError(event,0,true,error);error.js?error.js.localizedDescription:"ok";}`;

	const result = await runJXA(script);
	if (result !== 'ok') {
		throw new Error(`Failed to create event: ${result || 'unknown error'}`);
	}
}

export async function updateCalendarEvent(
	eventId: string,
	title: string,
	startISO: string,
	endISO: string,
): Promise<void> {
	const script = `${JXA_PRELUDE}var event=store.eventWithIdentifier("${escapeJXA(eventId)}");if(!event){"Event not found";}else{event.title=$("${escapeJXA(title)}");event.startDate=$.NSDate.dateWithTimeIntervalSince1970(new Date("${escapeJXA(startISO)}").getTime()/1000);event.endDate=$.NSDate.dateWithTimeIntervalSince1970(new Date("${escapeJXA(endISO)}").getTime()/1000);var error=$();store.saveEventSpanCommitError(event,0,true,error);error.js?error.js.localizedDescription:"ok";}`;

	const result = await runJXA(script);
	if (result === 'Event not found') {
		throw new Error('Event not found');
	}
	if (result !== 'ok') {
		throw new Error(`Failed to update event: ${result || 'unknown error'}`);
	}
}

export async function deleteCalendarEvent(eventId: string): Promise<void> {
	const script = `${JXA_PRELUDE}var event=store.eventWithIdentifier("${escapeJXA(eventId)}");if(!event){"Event not found";}else{var error=$();store.removeEventSpanCommitError(event,0,true,error);error.js?error.js.localizedDescription:"ok";}`;

	const result = await runJXA(script);
	if (result === 'Event not found') {
		throw new Error('Event not found');
	}
	if (result !== 'ok') {
		throw new Error(`Failed to delete event: ${result || 'unknown error'}`);
	}
}
