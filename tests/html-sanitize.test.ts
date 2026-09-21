import { describe, expect, it } from "vitest";
import { ALLOWED_TAGS, htmlToText, sanitizeHtml } from "../app/services/html-sanitize";

describe("sanitizeHtml", () => {
  it("keeps the allowed tags", () => {
    const html = "<p>Warm <strong>wool</strong> and <em>soft</em><br>lining</p><h2>Care</h2><ul><li>Hand wash</li></ul><ol><li>One</li></ol>";
    expect(sanitizeHtml(html)).toBe(html);
  });

  it("removes every attribute, including event handlers and styles", () => {
    expect(sanitizeHtml('<p onclick="steal()" style="color:red" class="x" id=y>Hi</p>')).toBe("<p>Hi</p>");
    expect(sanitizeHtml("<P ONMOUSEOVER=alert(1)>Hi</P>")).toBe("<p>Hi</p>");
  });

  it("removes scripts, styles and embeds together with their content", () => {
    expect(sanitizeHtml("<p>a</p><script>alert(1)</script><p>b</p>")).toBe("<p>a</p><p>b</p>");
    expect(sanitizeHtml("<style>p{}</style><p>a</p>")).toBe("<p>a</p>");
    expect(sanitizeHtml('<iframe src="https://evil.test"></iframe><p>a</p>')).toBe("<p>a</p>");
    expect(sanitizeHtml("<svg><script>alert(1)</script></svg><p>a</p>")).toBe("<p>a</p>");
    expect(sanitizeHtml("<p>a</p><script>never closed")).toBe("<p>a</p>");
    expect(sanitizeHtml("<SCRIPT>alert(1)</SCRIPT>ok")).toBe("ok");
  });

  it("removes links and images but keeps the link text", () => {
    expect(sanitizeHtml('<p>See <a href="javascript:alert(1)">our site</a></p>')).toBe("<p>See our site</p>");
    expect(sanitizeHtml('<p>x<img src=x onerror=alert(1)>y</p>')).toBe("<p>xy</p>");
  });

  it("drops unknown tags, keeps their text, maps common equivalents", () => {
    expect(sanitizeHtml("<div><span>text</span></div>")).toBe("text");
    expect(sanitizeHtml("<b>bold</b> <i>it</i> <h1>Title</h1>")).toBe("<strong>bold</strong> <em>it</em> <h2>Title</h2>");
    expect(sanitizeHtml("<table><tr><td>cell</td></tr></table>")).toBe("cell");
  });

  it("cannot be tricked by malformed or nested markup", () => {
    expect(sanitizeHtml("<scr<script>ipt>alert(1)</script>")).not.toMatch(/<script/i);
    expect(sanitizeHtml('<p title="a>b" onclick=x>t</p>')).not.toMatch(/onclick=x>t<\/p><|<p [^>]/);
    expect(sanitizeHtml("<<p>>hi")).toBe("&lt;<p>&gt;hi</p>");
    expect(sanitizeHtml("<p/onclick=alert(1)>x")).toBe("<p>x</p>");
    expect(sanitizeHtml("a < b and c > d")).toBe("a &lt; b and c &gt; d");
    expect(sanitizeHtml("<!-- c --><!DOCTYPE html><p>a</p>")).toBe("<p>a</p>");
  });

  it("only ever outputs allowed tags without attributes (property check)", () => {
    const nasty = [
      '<img src=x onerror=alert(1)>', "<script>x</script>", '<a href="javascript:x">l</a>', "<p onclick=x>", "</p>",
      "<ul><li>", "<<", ">>", '"', "'", "<svg/onload=1>", "<math><mi>", "&lt;script&gt;", "<p", "text", "<br/>", "</li></ul>",
      "<style>", "</style>", "<!--", "-->", "<iframe srcdoc='<script>1</script>'>", "<b>", "<h1 style=x>",
    ];
    const allowed = new RegExp(`^</?(?:${ALLOWED_TAGS.join("|")})>$`);
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
    for (let round = 0; round < 500; round++) {
      let input = "";
      for (let i = 0; i < 1 + (next() % 8); i++) input += nasty[next() % nasty.length];
      const out = sanitizeHtml(input);
      for (const tag of out.match(/<[^>]*>/g) ?? []) expect(tag, input).toMatch(allowed);
      expect(out.replace(/<[^>]*>/g, ""), input).not.toContain("<");
      expect(sanitizeHtml(out), input).toBe(out); // sanitizing twice changes nothing
    }
  });

  it("balances tags", () => {
    expect(sanitizeHtml("<ul><li>a<li>b</ul>")).toBe("<ul><li>a<li>b</li></li></ul>");
    expect(sanitizeHtml("</p>text</ul>")).toBe("text");
    expect(sanitizeHtml("<p><strong>open")).toBe("<p><strong>open</strong></p>");
  });

  it("keeps valid entities and escapes bare ampersands", () => {
    expect(sanitizeHtml("<p>Salt &amp; pepper &nbsp; &#169; R&D</p>")).toBe("<p>Salt &amp; pepper &nbsp; &#169; R&amp;D</p>");
  });
});

describe("htmlToText", () => {
  it("returns visible text only", () => {
    expect(htmlToText("<p>Warm&nbsp;<strong>wool</strong></p><script>x</script><ul><li>R&amp;D</li></ul>")).toBe("Warm wool R&D");
    expect(htmlToText("<p> </p><br>")).toBe("");
  });
});
