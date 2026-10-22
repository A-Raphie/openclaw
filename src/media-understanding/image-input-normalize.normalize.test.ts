import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  normalizeInputImageBuffer: vi.fn(async (params: { buffer: Buffer; mimeType?: string }) => ({
    buffer: params.buffer,
    mimeType: params.mimeType ?? "image/jpeg",
  })),
}));

vi.mock("../media/input-files.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../media/input-files.js")>()),
  normalizeInputImageBuffer: mocks.normalizeInputImageBuffer,
}));

import { normalizeImageDescriptionInput } from "./image-input-normalize.js";

describe("normalizeImageDescriptionInput", () => {
  beforeEach(() => {
    mocks.normalizeInputImageBuffer.mockClear();
  });

  it("normalizes AVIF payloads and allows the avif source mime", async () => {
    const buffer = Buffer.from("avif-bytes");
    await normalizeImageDescriptionInput({ buffer, mime: "image/avif" });

    expect(mocks.normalizeInputImageBuffer).toHaveBeenCalledWith(
      expect.objectContaining({
        buffer,
        mimeType: "image/avif",
        limits: expect.objectContaining({
          allowedMimes: expect.any(Set),
        }),
      }),
    );
    const limits = mocks.normalizeInputImageBuffer.mock.calls[0][0].limits;
    expect(limits.allowedMimes.has("image/avif")).toBe(true);
  });

  it("infers the avif mime from the .avif file extension", async () => {
    await normalizeImageDescriptionInput({
      buffer: Buffer.from("avif-bytes"),
      fileName: "screenshot.avif",
    });

    expect(mocks.normalizeInputImageBuffer).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: "image/avif" }),
    );
  });

  it("still normalizes HEIC payloads", async () => {
    await normalizeImageDescriptionInput({
      buffer: Buffer.from("heic-bytes"),
      mime: "image/heic",
    });

    expect(mocks.normalizeInputImageBuffer).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: "image/heic" }),
    );
  });

  it("leaves common images untouched", async () => {
    const buffer = Buffer.from("png-bytes");
    const result = await normalizeImageDescriptionInput({
      buffer,
      mime: "image/png",
    });

    expect(mocks.normalizeInputImageBuffer).not.toHaveBeenCalled();
    expect(result.buffer).toBe(buffer);
    expect(result.mime).toBe("image/png");
  });
});
