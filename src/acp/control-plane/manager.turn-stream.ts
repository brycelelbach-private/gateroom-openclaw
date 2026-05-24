import { AcpRuntimeError } from "../runtime/errors.js";
import type { AcpRuntime, AcpRuntimeEvent, AcpRuntimeTurnInput } from "../runtime/types.js";
import { normalizeAcpErrorCode } from "./manager.utils.js";
import { normalizeText } from "./runtime-options.js";

export type AcpTurnEventGate = {
  open: boolean;
};

export type AcpTurnStreamOutcome = {
  sawOutput: boolean;
  sawTerminalEvent: boolean;
};

// After the turn signal aborts, give the runtime adapter this long to wind down
// gracefully (typically: yield a final `done` event after the agent acknowledges
// cancel). If the iterator still has not settled by the deadline, we stop
// pulling from it. The runtime side-channel cancel is what tears the underlying
// transport down — without this fallback the per-session actor lock is held
// until the 48-hour turn timeout fires, which wedges every follow-up message
// on the session.
const ACP_TURN_STREAM_ABORT_GRACE_MS = 5_000;

const ABORT_SENTINEL: unique symbol = Symbol("acp-turn-stream-abort-fired");
const TIMEOUT_SENTINEL: unique symbol = Symbol("acp-turn-stream-abort-timeout");

export async function consumeAcpTurnStream(params: {
  runtime: AcpRuntime;
  turn: AcpRuntimeTurnInput;
  eventGate: AcpTurnEventGate;
  onEvent?: (event: AcpRuntimeEvent) => Promise<void> | void;
  onOutputEvent?: (
    event: Extract<AcpRuntimeEvent, { type: "text_delta" | "tool_call" }>,
  ) => Promise<void> | void;
  abortGraceMs?: number;
}): Promise<AcpTurnStreamOutcome> {
  let streamError: AcpRuntimeError | null = null;
  let sawOutput = false;
  let sawTerminalEvent = false;

  const graceMs = params.abortGraceMs ?? ACP_TURN_STREAM_ABORT_GRACE_MS;
  const signal = params.turn.signal;
  const iterable = params.runtime.runTurn(params.turn);
  const iterator = iterable[Symbol.asyncIterator]();

  let abortDeadlineMs: number | undefined;
  let abortObserved = false;
  let abortPromise: Promise<typeof ABORT_SENTINEL> | null = null;
  let abortListener: (() => void) | undefined;

  if (signal?.aborted === true) {
    abortDeadlineMs = Date.now() + graceMs;
    abortObserved = true;
  } else if (signal) {
    abortPromise = new Promise<typeof ABORT_SENTINEL>((resolve) => {
      abortListener = () => {
        abortDeadlineMs ??= Date.now() + graceMs;
        resolve(ABORT_SENTINEL);
      };
      signal.addEventListener("abort", abortListener, { once: true });
    });
  }

  const releaseAbortListener = () => {
    if (signal && abortListener) {
      signal.removeEventListener("abort", abortListener);
      abortListener = undefined;
    }
  };

  const requestIteratorReturn = () => {
    if (typeof iterator.return === "function") {
      // Politely ask the iterator to clean up, but do not await — if `next()`
      // is hanging, `return()` may hang too.
      void Promise.resolve()
        .then(() => iterator.return?.(undefined))
        .catch(() => undefined);
    }
  };

  // The same `iterator.next()` promise is reused across loop iterations until
  // it resolves or we abandon it; calling `iterator.next()` a second time
  // before the first settles would queue a second outstanding request to the
  // adapter.
  let pendingNext: Promise<IteratorResult<AcpRuntimeEvent>> | null = null;

  try {
    while (true) {
      if (abortObserved && abortDeadlineMs !== undefined && Date.now() >= abortDeadlineMs) {
        if (pendingNext) {
          void pendingNext.catch(() => undefined);
          pendingNext = null;
        }
        requestIteratorReturn();
        break;
      }

      pendingNext ??= iterator.next();

      const raceParticipants: Array<
        | Promise<IteratorResult<AcpRuntimeEvent>>
        | Promise<typeof ABORT_SENTINEL>
        | Promise<typeof TIMEOUT_SENTINEL>
      > = [pendingNext];
      if (!abortObserved && abortPromise) {
        raceParticipants.push(abortPromise);
      }
      let timeoutTimer: NodeJS.Timeout | undefined;
      if (abortObserved && abortDeadlineMs !== undefined) {
        const remaining = Math.max(1, abortDeadlineMs - Date.now());
        raceParticipants.push(
          new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
            timeoutTimer = setTimeout(() => resolve(TIMEOUT_SENTINEL), remaining);
            timeoutTimer.unref?.();
          }),
        );
      }

      const raced = await Promise.race(raceParticipants);
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }

      if (raced === ABORT_SENTINEL) {
        abortObserved = true;
        // Keep `pendingNext` and loop again — next iteration races it against
        // the freshly-armed grace timeout.
        continue;
      }
      if (raced === TIMEOUT_SENTINEL) {
        if (pendingNext) {
          void pendingNext.catch(() => undefined);
          pendingNext = null;
        }
        requestIteratorReturn();
        break;
      }

      const result = raced;
      pendingNext = null;
      if (result.done) {
        break;
      }
      const event = result.value;
      if (!params.eventGate.open) {
        continue;
      }
      if (event.type === "done") {
        sawTerminalEvent = true;
      } else if (event.type === "error") {
        streamError = new AcpRuntimeError(
          normalizeAcpErrorCode(event.code),
          normalizeText(event.message) || "ACP turn failed before completion.",
        );
      } else if (event.type === "text_delta" || event.type === "tool_call") {
        sawOutput = true;
        await params.onOutputEvent?.(event);
      }
      await params.onEvent?.(event);
    }
  } finally {
    releaseAbortListener();
  }

  if (params.eventGate.open && streamError) {
    throw streamError;
  }

  return {
    sawOutput,
    sawTerminalEvent,
  };
}
