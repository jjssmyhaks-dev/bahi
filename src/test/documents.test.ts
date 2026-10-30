import { describe, expect, it, vi } from "vitest";

import { extractFileText } from "@/server/documents.server";

const vision = vi.hoisted(() => ({ enabled: false, text: "" }));

vi.mock("@/server/vision.server", () => ({
  visionEnabled: () => vision.enabled,
  transcribeImages: async () => ({ text: vision.text, pages: 1, model: "test-vision" }),
  transcribePdf: async () => ({ text: vision.text, pages: 1, model: "test-vision" }),
}));

const image = (name = "bill.jpg", mimeType = "image/jpeg") => ({
  buffer: Buffer.from("not-a-real-jpeg"),
  mimeType,
  name,
});

describe("vision extraction gating", () => {
  it("explains that photos need the vision model when it is off", async () => {
    vision.enabled = false;
    const result = await extractFileText(image().buffer, image().mimeType, image().name);
    expect(result.text).toBe("");
    expect(result.renderMode).toBeNull();
    expect(result.error).toContain("vision model");
  });

  it("marks photo text as read by vision", async () => {
    vision.enabled = true;
    vision.text = "Shree Metals Works | GSTIN 27ABCDE1234F1Z5 | Invoice 42 | Total 11800";
    const result = await extractFileText(image().buffer, image().mimeType, image().name);
    expect(result.error).toBeNull();
    expect(result.renderMode).toBe("vision");
    expect(result.text).toContain("Invoice 42");
  });

  it("refuses a transcription that has no usable text", async () => {
    vision.enabled = true;
    vision.text = "   ";
    const result = await extractFileText(image().buffer, image().mimeType, image().name);
    expect(result.renderMode).toBeNull();
    expect(result.error).toContain("could not make out");
  });

  it("labels plain text uploads as text renders", async () => {
    const result = await extractFileText(
      Buffer.from("Supplier, GSTIN, Invoice\nAcme, 27ABCDE1234F1Z5, 42"),
      "text/csv",
      "bills.csv",
    );
    expect(result.renderMode).toBe("text");
    expect(result.error).toBeNull();
  });
});
