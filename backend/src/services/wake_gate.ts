export type WakeDecision = {
  accepted: boolean;
  heardWakeWord: boolean;
  command: string;
  state: "standby" | "armed" | "command";
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class WakeGate {
  private armedUntil = 0;
  private readonly pattern: RegExp;

  constructor(readonly wakeWord: string, private readonly windowMs: number) {
    this.pattern = new RegExp(`\\b${escapeRegExp(wakeWord.trim() || "Bob")}\\b`, "i");
  }

  preview(text: string, now = Date.now()): WakeDecision {
    const trimmed = text.trim();
    const match = this.pattern.exec(trimmed);
    if (match) {
      return {
        accepted: true,
        heardWakeWord: true,
        command: trimmed.slice(match.index + match[0].length).replace(/^[\s,.:;!?-]+/, "").trim(),
        state: "armed"
      };
    }
    if (now < this.armedUntil) {
      return { accepted: true, heardWakeWord: false, command: trimmed, state: "armed" };
    }
    return { accepted: false, heardWakeWord: false, command: "", state: "standby" };
  }

  consume(text: string, now = Date.now()): WakeDecision {
    const preview = this.preview(text, now);
    if (!preview.accepted) return preview;
    if (preview.heardWakeWord && !preview.command) {
      this.armedUntil = now + Math.max(1000, this.windowMs);
      return { ...preview, state: "armed" };
    }
    this.armedUntil = 0;
    return { ...preview, state: "command" };
  }

  reset(): void {
    this.armedUntil = 0;
  }
}
