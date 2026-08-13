import { exec } from 'child_process';
import { Platform } from 'obsidian';

// macOS Reminders access via JXA/EventKit, ported from lite-reminders
// (src/storage.ts). Unlike the plugin version this layer never shows
// Notices — failures are thrown so the HTTP handler can return them.

export interface ReminderItem {
	id: string;
	title: string;
	list: string;
	due?: string;
}

const DEFAULT_LIST = 'Inbox';

const execAsync = (command: string, options: { timeout: number }): Promise<string> => {
	return new Promise<string>((resolve, reject) => {
		exec(command, options, (err: unknown, stdout: unknown) => {
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
		throw new Error('Reminders API is only available on macOS');
	}
}

async function runJXA(script: string): Promise<string | null> {
	assertMacOS();
	try {
		const stdout = await execAsync(`osascript -l JavaScript -e '${script}'`, { timeout: 30000 });
		return stdout.trim();
	} catch (error: unknown) {
		const msg = error instanceof Error ? error.message : String(error);
		console.error('[note-api] Reminders JXA error:', msg);
		throw new Error(`Reminders operation failed: ${msg}`);
	}
}

function escapeJXA(str: string): string {
	return str
		.replace(/\\/g, '\\\\')
		.replace(/"/g, '\\"')
		.replace(/\n/g, '\\n');
}

function sanitizeListName(listName: string | undefined): string {
	const trimmed = (listName ?? '').trim();
	return trimmed || DEFAULT_LIST;
}

// Builds the NSDateComponents assignment shared by create/update. A missing
// due clears the date when `clearWhenMissing` is set (update semantics).
function dueAssignment(due: string | undefined, targetVar: string, clearWhenMissing: boolean): string {
	if (due) {
		return `var d=new Date("${escapeJXA(due)}");var comps=$.NSDateComponents.alloc.init;comps.year=d.getFullYear();comps.month=d.getMonth()+1;comps.day=d.getDate();comps.hour=d.getHours();comps.minute=d.getMinutes();${targetVar}.dueDateComponents=comps;`;
	}
	return clearWhenMissing ? `${targetVar}.dueDateComponents=null;` : '';
}

export async function listReminders(listName?: string): Promise<ReminderItem[]> {
	const target = escapeJXA(sanitizeListName(listName));
	const script = `ObjC.import("EventKit");var store=$.EKEventStore.alloc.init;var status=$.EKEventStore.authorizationStatusForEntityType(1);if(status!=3){store.requestAccessToEntityTypeCompletion(1,null);delay(3);}var cals=store.calendarsForEntityType(1);var predicate=store.predicateForRemindersInCalendars(cals);var allReminders=store.remindersMatchingPredicate(predicate);var result=[];var valid=function(n,min,max){n=Number(n);return isFinite(n)&&n>=min&&n<=max;};for(var i=0;i<allReminders.count;i++){var r=allReminders.objectAtIndex(i);if(r.completed)continue;var cal=ObjC.unwrap(r.calendar.title);if(cal!=="${target}")continue;var item={title:ObjC.unwrap(r.title),id:ObjC.unwrap(r.calendarItemIdentifier),list:cal};var comps=r.dueDateComponents;if(comps){var y=Number(comps.year),m=Number(comps.month),d=Number(comps.day);if(valid(y,1,9999)&&valid(m,1,12)&&valid(d,1,31)){var h=Number(comps.hour),minute=Number(comps.minute);if(!valid(h,0,23))h=0;if(!valid(minute,0,59))minute=0;var due=new Date(y,m-1,d,h,minute);if(!isNaN(due.getTime()))item.due=due.toISOString();}}result.push(item);}JSON.stringify(result);`;

	const result = await runJXA(script);
	if (!result) return [];
	try {
		const parsed: unknown = JSON.parse(result);
		if (!Array.isArray(parsed)) return [];
		const reminders: ReminderItem[] = [];
		for (const item of parsed) {
			if (item === null || typeof item !== 'object') continue;
			const obj = item as Record<string, unknown>;
			if (typeof obj.id !== 'string' || typeof obj.title !== 'string') continue;
			reminders.push({
				id: obj.id,
				title: obj.title,
				list: typeof obj.list === 'string' ? obj.list : '',
				due: typeof obj.due === 'string' ? obj.due : undefined,
			});
		}
		// Soonest due first; reminders without a due date sink to the bottom.
		reminders.sort((a, b) => {
			if (!a.due && !b.due) return 0;
			if (!a.due) return 1;
			if (!b.due) return -1;
			return new Date(a.due).getTime() - new Date(b.due).getTime();
		});
		return reminders;
	} catch {
		return [];
	}
}

export async function listReminderLists(): Promise<string[]> {
	const script = `ObjC.import("EventKit");var store=$.EKEventStore.alloc.init;var status=$.EKEventStore.authorizationStatusForEntityType(1);if(status!=3){store.requestAccessToEntityTypeCompletion(1,null);delay(3);}var cals=store.calendarsForEntityType(1);var result=[];for(var i=0;i<cals.count;i++){result.push(ObjC.unwrap(cals.objectAtIndex(i).title));}JSON.stringify(result);`;
	const result = await runJXA(script);
	if (!result) return [DEFAULT_LIST];
	try {
		const parsed: unknown = JSON.parse(result);
		if (!Array.isArray(parsed)) return [DEFAULT_LIST];
		return parsed.filter((item): item is string => typeof item === 'string');
	} catch {
		return [DEFAULT_LIST];
	}
}

export async function createReminder(title: string, listName?: string, due?: string): Promise<void> {
	const titleEsc = escapeJXA(title);
	const listEsc = escapeJXA(sanitizeListName(listName));
	const script = `ObjC.import("EventKit");var store=$.EKEventStore.alloc.init;var status=$.EKEventStore.authorizationStatusForEntityType(1);if(status!=3){store.requestAccessToEntityTypeCompletion(1,null);delay(3);}var cals=store.calendarsForEntityType(1);var targetCal=null;for(var i=0;i<cals.count;i++){var cal=cals.objectAtIndex(i);if(ObjC.unwrap(cal.title)==="${listEsc}"){targetCal=cal;break;}}if(!targetCal){"calendar not found";}else{var r=$.EKReminder.reminderWithEventStore(store);r.title=$("${titleEsc}");r.calendar=targetCal;${dueAssignment(due, 'r', false)}var error=$();store.saveReminderCommitError(r,true,error);error.js?error.js.localizedDescription:"ok";}`;
	const result = await runJXA(script);
	if (result !== 'ok') {
		throw new Error(result ? `Failed to create reminder: ${result}` : 'Failed to create reminder');
	}
}

export async function updateReminder(id: string, title: string, due?: string): Promise<void> {
	const idEsc = escapeJXA(id);
	const titleEsc = escapeJXA(title);
	const script = `ObjC.import("EventKit");var store=$.EKEventStore.alloc.init;var item=store.calendarItemWithIdentifier("${idEsc}");if(!item){"not found";}else{item.title=$("${titleEsc}");${dueAssignment(due, 'item', true)}var error=$();store.saveReminderCommitError(item,true,error);error.js?error.js.localizedDescription:"ok";}`;
	const result = await runJXA(script);
	if (result === 'not found') {
		throw new Error('Reminder not found');
	}
	if (result !== 'ok') {
		throw new Error(result ? `Failed to update reminder: ${result}` : 'Failed to update reminder');
	}
}

export async function completeReminder(id: string): Promise<void> {
	const idEsc = escapeJXA(id);
	const script = `ObjC.import("EventKit");var store=$.EKEventStore.alloc.init;var item=store.calendarItemWithIdentifier("${idEsc}");if(!item){"not found";}else{item.completed=true;var error=$();store.saveReminderCommitError(item,true,error);error.js?error.js.localizedDescription:"ok";}`;
	const result = await runJXA(script);
	if (result === 'not found') {
		throw new Error('Reminder not found');
	}
	if (result !== 'ok') {
		throw new Error(result ? `Failed to complete reminder: ${result}` : 'Failed to complete reminder');
	}
}

export async function deleteReminder(id: string): Promise<void> {
	const idEsc = escapeJXA(id);
	const script = `ObjC.import("EventKit");var store=$.EKEventStore.alloc.init;var item=store.calendarItemWithIdentifier("${idEsc}");if(!item){"not found";}else{var error=$();store.removeReminderCommitError(item,true,error);error.js?error.js.localizedDescription:"ok";}`;
	const result = await runJXA(script);
	if (result === 'not found') {
		throw new Error('Reminder not found');
	}
	if (result !== 'ok') {
		throw new Error(result ? `Failed to delete reminder: ${result}` : 'Failed to delete reminder');
	}
}
