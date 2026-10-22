import { describe, expect, it } from "vitest";
import { normalizeImageDescriptionInput } from "./image-input-normalize.js";

// Real 1x1 AVIF and HEIC attachments (generated with macOS sips). These exercise
// the production Rastermill decode path end to end instead of mocking the shared
// converter, so the tests fail if AVIF/HEIC bytes ever reach the provider unconverted.
const AVIF_1X1 = Buffer.from(
  "AAAAGGZ0eXBhdmlmAAAAAGF2aWZtaWYxAAABSm1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAHBpY3QAAAAAAAAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAADnBpdG0AAAAAAAEAAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABhdjAxAAAAAKppcHJwAAAAiGlwY28AAAATY29scm5jbHgAAgACAAaAAAAADGNsbGkAywBAAAAAFGlzcGUAAAAAAAAAAgAAAAIAAAAoY2xhcAAAAAEAAAABAAAAAQAAAAH/wAAAAIAAAP/AAAAAgAAAAAAACWlyb3QAAAAAEHBpeGkAAAAAAwgICAAAAAxhdjFDgQAMAAAAABppcG1hAAAAAAAAAAEAAQeBAgMGh4SFAAAAHmlsb2MAAAAARAAAAQABAAAAAQAAAXIAAAAvAAAAAW1kYXQAAAAAAAAAPxIACgwAAAAABn/8CBAQNCAyHRABkgAIIIIoA3U00TBP/c/03D5D4njrPFntQWdQ",
  "base64",
);
const HEIC_1X1 = Buffer.from(
  "AAAAGGZ0eXBoZWljAAAAAGhlaWNtaWYxAAABsG1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAHBpY3QAAAAAAAAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAADnBpdG0AAAAAAAEAAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABodmMxAAAAARBpcHJwAAAA7mlwY28AAAATY29scm5jbHgAAgACAAaAAAAADGNsbGkAywBAAAAAFGlzcGUAAAAAAAAAAgAAAAIAAAAoY2xhcAAAAAEAAAABAAAAAQAAAAH/wAAAAIAAAP/AAAAAgAAAAAAACWlyb3QAAAAAEHBpeGkAAAAAAwgICAAAAHJodmNDAQNwAAAAsAAAAAAAHvAA/P34+AAACwOgAAEAF0ABDAH//wNwAAADALAAAAMAAAMAHnAkoQABACRCAQEDcAAAAwCwAAADAAADAB6gFCBBwKEEGIe5FlU3AgIGAICiAAEACUQBwGFyyEBTJAAAABppcG1hAAAAAAAAAAEAAQeBAgMGh4SFAAAAHmlsb2MAAAAARAAAAQABAAAAAQAAAdgAAABQAAAAAW1kYXQAAAAAAAAAYAAAAEwoAa+jYxGV0gXBMVXzC4n/motjhLKp//+VGy42Z+D5jqo7BTT0rMf/J/zT9gX1vzH/aANmTK4sGufssfYuWjarjP9N2WPd+yGseAho",
  "base64",
);

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

function assertJpeg(buffer: Buffer): void {
  expect(buffer.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)).toBe(true);
}

describe("normalizeImageDescriptionInput", () => {
  it("converts real AVIF bytes to JPEG before image description", async () => {
    const result = await normalizeImageDescriptionInput({
      buffer: AVIF_1X1,
      mime: "image/avif",
    });

    expect(result.mime).toBe("image/jpeg");
    assertJpeg(result.buffer);
  });

  it("converts AVIF declared only by the .avif file extension", async () => {
    const result = await normalizeImageDescriptionInput({
      buffer: AVIF_1X1,
      fileName: "screenshot.avif",
    });

    expect(result.mime).toBe("image/jpeg");
    assertJpeg(result.buffer);
  });

  it("still converts real HEIC bytes to JPEG", async () => {
    const result = await normalizeImageDescriptionInput({
      buffer: HEIC_1X1,
      mime: "image/heic",
    });

    expect(result.mime).toBe("image/jpeg");
    assertJpeg(result.buffer);
  });

  it("leaves common images untouched", async () => {
    const buffer = Buffer.from("png-bytes");
    const result = await normalizeImageDescriptionInput({
      buffer,
      mime: "image/png",
    });

    expect(result.buffer).toBe(buffer);
    expect(result.mime).toBe("image/png");
  });
});
