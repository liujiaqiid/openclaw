import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getQueuedFileWriter, type QueuedFileWriter } from "./queued-file-writer.js";

describe("QueuedFileWriter", () => {
  const writers = new Map<string, QueuedFileWriter>();

  afterEach(() => {
    writers.clear();
  });

  it("writes lines to a file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qfw-test-"));
    const filePath = path.join(dir, "test.log");
    const writer = getQueuedFileWriter(writers, filePath);

    writer.write("line1\n");
    writer.write("line2\n");

    // Wait for the queue to drain
    await writer.drain();

    const content = await fs.readFile(filePath, "utf8");
    expect(content).toBe("line1\nline2\n");

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("reuses existing writer for same filePath", () => {
    const dir = os.tmpdir();
    const filePath = path.join(dir, "qfw-reuse.log");
    const w1 = getQueuedFileWriter(writers, filePath);
    const w2 = getQueuedFileWriter(writers, filePath);
    expect(w1).toBe(w2);
  });

  it("warns after consecutive write failures", async () => {
    const dir = path.join(os.tmpdir(), "qfw-no-exist-" + process.pid);
    const filePath = path.join(dir, "sub", "test.log");

    // Create the directory so mkdir succeeds, but make the file unwritable
    await fs.mkdir(path.join(dir, "sub"), { recursive: true });
    // Create a directory where the file should be — appendFile will fail
    await fs.mkdir(filePath, { recursive: true });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const writer = getQueuedFileWriter(writers, filePath);

    // Trigger 3 write failures
    writer.write("a\n");
    writer.write("b\n");
    writer.write("c\n");

    // Wait for queue to drain
    await writer.drain();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("QueuedFileWriter");
    expect(warnSpy.mock.calls[0]?.[0]).toContain("3 consecutive write failures");
    expect(warnSpy.mock.calls[0]?.[0]).toContain(filePath);

    warnSpy.mockRestore();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("resets failure count on successful write", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qfw-reset-"));
    const filePath = path.join(dir, "test.log");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const writer = getQueuedFileWriter(writers, filePath);

    // Induce 2 failures (not enough to trigger warning)
    // Make the file unwritable by replacing it with a directory
    await fs.rm(filePath, { force: true });
    await fs.mkdir(filePath, { recursive: true });

    writer.write("fail1\n");
    writer.write("fail2\n");
    await writer.drain();

    // No warning yet (only 2 failures)
    expect(warnSpy).not.toHaveBeenCalled();

    // Now make it writable again (remove directory, create file)
    await fs.rm(filePath, { force: true });

    // Successful write - resets failure count
    writer.write("ok1\n");
    await writer.drain();

    // Make it unwritable again
    await fs.rm(filePath, { force: true });
    await fs.mkdir(filePath, { recursive: true });

    // Induce 2 more failures - should NOT trigger warning because count was reset
    writer.write("fail3\n");
    writer.write("fail4\n");
    await writer.drain();

    // Still no warning (only 2 failures after reset)
    expect(warnSpy).not.toHaveBeenCalled();

    // One more failure to reach threshold
    writer.write("fail5\n");
    await writer.drain();

    // Now warning should fire (3 failures after reset)
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("3 consecutive write failures");

    warnSpy.mockRestore();
    await fs.rm(dir, { recursive: true, force: true });
  });
});
