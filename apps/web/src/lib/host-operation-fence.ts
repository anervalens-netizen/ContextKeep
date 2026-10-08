/** One fence per mounted MCP app, not per selected task/component. */
export class HostOperationFence {
  pending = false;
  messageUncertain = false;
  constructor(private readonly changed: () => void = () => {}) {}
  async run<T>(
    kind: "attach" | "send",
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.pending || (kind === "send" && this.messageUncertain))
      throw new Error(
        "Inspect the previous host operation before sending again.",
      );
    this.pending = true;
    this.changed();
    try {
      const result = await operation();
      if (
        kind === "send" &&
        result &&
        typeof result === "object" &&
        "isError" in result &&
        result.isError === true
      )
        throw new Error("The host did not accept the message.");
      return result;
    } catch (error) {
      if (kind === "send") this.messageUncertain = true;
      throw error;
    } finally {
      this.pending = false;
      this.changed();
    }
  }
}
