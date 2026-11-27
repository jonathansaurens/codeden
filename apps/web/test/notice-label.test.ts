import { PROVIDER_SWITCH_CODE, ROLE_PLACEMENT_CODE } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { noticeLabel } from "@/components/thread/cards/simple-cards";

describe("notice labels", () => {
  it("names CodeDen's own notices in words and keeps a provider's code", () => {
    expect(noticeLabel(ROLE_PLACEMENT_CODE)).toBe("Runs on");
    expect(noticeLabel(PROVIDER_SWITCH_CODE)).toBe("Provider switch");
    expect(noticeLabel("context_compacted")).toBe("context_compacted");
    expect(noticeLabel(undefined)).toBeUndefined();
  });
});
