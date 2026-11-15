// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { OutputLimitNotice } from "@/components/message/OutputLimitNotice";
import { getLanguage, getTranslations } from "@/lib/i18n";

afterEach(cleanup);

const tr = getTranslations(getLanguage()).chatUi;

describe("OutputLimitNotice", () => {
  it("warns that the reply was cut and names the setting that raises the limit", () => {
    render(<OutputLimitNotice hit={{ cut: true, retried: false, limit: 32_768 }} />);
    const notice = screen.getByRole("status");
    expect(notice.textContent).toContain(tr.outputLimitCut);
    expect(notice.textContent).toContain((32_768).toLocaleString());
    expect(notice.textContent).not.toContain("{setting}");
    expect(screen.getByText("generation.maxOutputTokens").tagName).toBe("CODE");
  });

  it("says the retry recovered a step that only thought, without a hint when no limit is known", () => {
    render(<OutputLimitNotice hit={{ cut: false, retried: true }} />);
    const notice = screen.getByRole("status");
    expect(notice.textContent).toBe(tr.outputLimitRetried);
  });
});
