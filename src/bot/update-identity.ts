/**
 * Pure Telegram-update identity: who an update is from, which conversation it
 * belongs to, and what (if anything) it carries as callback data. Dependency-free
 * and Worker-safe, so the webhook ingress, durable runners, and tests all share
 * one directly-testable routing/deduplication contract.
 */

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as JsonRecord)
		: null;
}

function integer(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value)
		? value
		: null;
}

function nestedId(value: unknown, parent: string): number | null {
	return integer(record(record(value)?.[parent])?.id);
}

/** Telegram's globally unique integer update id, used for durable de-duplication. */
export function telegramUpdateId(update: unknown): number | null {
	return integer(record(update)?.update_id);
}

/** The raw callback_data payload, when this is a callback-query update. */
export function telegramCallbackData(update: unknown): string | null {
	const data = record(record(update)?.callback_query)?.data;
	return typeof data === "string" ? data : null;
}

/** The tapper's Telegram user id, when this is a callback-query update. */
export function telegramCallbackUserId(update: unknown): number | null {
	return nestedId(record(update)?.callback_query, "from");
}

/**
 * Route one conversation to one Durable Object so its updates remain ordered while unrelated chats
 * can run concurrently. Every current Telegram update shape either carries a chat or an actor; the
 * update id is the safe final partition when it carries neither (for example a poll update).
 */
export function telegramUpdatePartition(update: unknown): string | null {
	const root = record(update);
	const updateId = telegramUpdateId(update);
	if (!root || updateId === null) return null;

	const chatCarriers = [
		"message",
		"edited_message",
		"channel_post",
		"edited_channel_post",
		"business_message",
		"edited_business_message",
		"deleted_business_messages",
		"message_reaction",
		"message_reaction_count",
		"my_chat_member",
		"chat_member",
		"chat_join_request",
		"chat_boost",
		"removed_chat_boost",
	] as const;
	for (const key of chatCarriers) {
		const chatId = nestedId(root[key], "chat");
		if (chatId !== null) return `chat:${chatId}`;
	}

	const callback = record(root.callback_query);
	const callbackChatId = nestedId(callback?.message, "chat");
	if (callbackChatId !== null) return `chat:${callbackChatId}`;

	const actorCarriers = [
		"inline_query",
		"chosen_inline_result",
		"callback_query",
		"shipping_query",
		"pre_checkout_query",
		"purchased_paid_media",
		"poll_answer",
		"business_connection",
	] as const;
	for (const key of actorCarriers) {
		const carrier = root[key];
		const fromId = nestedId(carrier, "from");
		if (fromId !== null) return `user:${fromId}`;
		const userId = nestedId(carrier, "user");
		if (userId !== null) return `user:${userId}`;
		const voterChatId = nestedId(carrier, "voter_chat");
		if (voterChatId !== null) return `chat:${voterChatId}`;
	}

	return `update:${updateId}`;
}
