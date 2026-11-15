use std::collections::HashMap;

pub enum Fuzzy {
    One {
        start: usize,
        end: usize,
        replacement: String,
        strategy: &'static str,
    },
    None,
    Many(usize),
}

struct Line<'a> {
    start: usize,
    end: usize,
    body: &'a str,
}

fn split_lines(content: &str) -> Vec<Line<'_>> {
    let mut lines = Vec::new();
    let mut pos = 0usize;
    for raw in content.split_inclusive('\n') {
        let body = raw.strip_suffix('\n').unwrap_or(raw);
        let body = body.strip_suffix('\r').unwrap_or(body);
        lines.push(Line {
            start: pos,
            end: pos + raw.len(),
            body,
        });
        pos += raw.len();
    }
    lines
}

fn line_end_without_eol(content: &str, line: &Line<'_>) -> usize {
    let slice = &content[line.start..line.end];
    if slice.ends_with("\r\n") {
        line.end - 2
    } else if slice.ends_with('\n') {
        line.end - 1
    } else {
        line.end
    }
}

fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn leading_ws(s: &str) -> &str {
    let n = s.len() - s.trim_start().len();
    &s[..n]
}

fn reindent(new: &str, old_indent: &str, file_indent: &str) -> String {
    if old_indent == file_indent {
        return new.to_string();
    }
    new.split('\n')
        .map(|l| {
            if l.trim().is_empty() {
                l.to_string()
            } else if let Some(rest) = l.strip_prefix(old_indent) {
                format!("{file_indent}{rest}")
            } else if old_indent.is_empty() {
                format!("{file_indent}{l}")
            } else {
                l.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn first_non_blank(s: &str) -> Option<&str> {
    s.split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .find(|l| !l.trim().is_empty())
}

fn line_window_match(
    content: &str,
    lines: &[Line<'_>],
    needle: &str,
    norm: fn(&str) -> String,
) -> Vec<(usize, usize)> {
    let sig: Vec<usize> = (0..lines.len())
        .filter(|&i| !lines[i].body.trim().is_empty())
        .collect();
    let wanted: Vec<String> = needle
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .filter(|l| !l.trim().is_empty())
        .map(norm)
        .collect();
    if wanted.is_empty() || wanted.len() > sig.len() {
        return Vec::new();
    }
    let normalized: Vec<String> = sig.iter().map(|&i| norm(lines[i].body)).collect();
    let mut hits = Vec::new();
    for w in 0..=(sig.len() - wanted.len()) {
        if (0..wanted.len()).all(|k| normalized[w + k] == wanted[k]) {
            let first = &lines[sig[w]];
            let last = &lines[sig[w + wanted.len() - 1]];
            hits.push((first.start, line_end_without_eol(content, last)));
        }
    }
    hits
}

fn unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.peek() {
                Some('n') => {
                    out.push('\n');
                    chars.next();
                }
                Some('t') => {
                    out.push('\t');
                    chars.next();
                }
                Some('"') => {
                    out.push('"');
                    chars.next();
                }
                Some('\'') => {
                    out.push('\'');
                    chars.next();
                }
                Some('\\') => {
                    out.push('\\');
                    chars.next();
                }
                _ => out.push(c),
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn bigrams(s: &str) -> HashMap<(char, char), usize> {
    let chars: Vec<char> = s.chars().collect();
    let mut map = HashMap::new();
    for w in chars.windows(2) {
        *map.entry((w[0], w[1])).or_insert(0) += 1;
    }
    map
}

pub fn similarity(a: &str, b: &str) -> f64 {
    if a == b {
        return 1.0;
    }
    if a.chars().count() < 2 || b.chars().count() < 2 {
        return 0.0;
    }
    let (ma, mb) = (bigrams(a), bigrams(b));
    let total: usize = ma.values().sum::<usize>() + mb.values().sum::<usize>();
    let shared: usize = ma
        .iter()
        .map(|(k, v)| (*v).min(*mb.get(k).unwrap_or(&0)))
        .sum();
    (2 * shared) as f64 / total as f64
}

const ANCHOR_SIMILARITY: f64 = 0.65;

fn anchor_match(content: &str, lines: &[Line<'_>], needle: &str) -> Vec<(usize, usize, usize)> {
    let wanted: Vec<&str> = needle
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l).trim())
        .filter(|l| !l.is_empty())
        .collect();
    if wanted.len() < 3 {
        return Vec::new();
    }
    let first = wanted[0];
    let last = wanted[wanted.len() - 1];
    let middle = wanted[1..wanted.len() - 1].join("\n");
    let max_span = (wanted.len() + 3).max(wanted.len() * 2);
    let mut hits = Vec::new();
    for i in 0..lines.len() {
        if lines[i].body.trim() != first {
            continue;
        }
        let stop = (i + max_span).min(lines.len());
        for j in (i + 2)..stop {
            if lines[j].body.trim() != last {
                continue;
            }
            let got: Vec<&str> = lines[i + 1..j]
                .iter()
                .map(|l| l.body.trim())
                .filter(|l| !l.is_empty())
                .collect();
            if similarity(&got.join("\n"), &middle) >= ANCHOR_SIMILARITY {
                hits.push((lines[i].start, line_end_without_eol(content, &lines[j]), i));
            }
            break;
        }
    }
    hits
}

pub fn locate(content: &str, needle: &str, new: &str) -> Fuzzy {
    let lines = split_lines(content);
    let old_indent = first_non_blank(needle).map(leading_ws).unwrap_or("");

    type Norm = fn(&str) -> String;
    let strategies: [(&'static str, Norm, bool); 3] = [
        (
            "trailing whitespace and blank lines",
            |s: &str| s.trim_end().to_string(),
            false,
        ),
        (
            "different indentation",
            |s: &str| s.trim().to_string(),
            true,
        ),
        ("different inner whitespace", collapse_ws, true),
    ];
    for (strategy, norm, adapt) in strategies {
        let hits = line_window_match(content, &lines, needle, norm);
        match hits.len() {
            0 => continue,
            1 => {
                let (start, end) = hits[0];
                let replacement = if adapt {
                    let file_indent = first_non_blank(&content[start..end])
                        .map(leading_ws)
                        .unwrap_or("");
                    reindent(new, old_indent, file_indent)
                } else {
                    new.to_string()
                };
                return Fuzzy::One {
                    start,
                    end,
                    replacement,
                    strategy,
                };
            }
            n => return Fuzzy::Many(n),
        }
    }

    let unescaped = unescape(needle);
    if unescaped != needle {
        let count = content.matches(&unescaped).count();
        if count == 1 {
            let start = content.find(&unescaped).unwrap_or(0);
            let replacement = if !new.contains('\n') && new.contains("\\n") {
                unescape(new)
            } else {
                new.to_string()
            };
            return Fuzzy::One {
                start,
                end: start + unescaped.len(),
                replacement,
                strategy: "doubled escape sequences",
            };
        }
        if count > 1 {
            return Fuzzy::Many(count);
        }
    }

    let anchors = anchor_match(content, &lines, needle);
    match anchors.len() {
        0 => Fuzzy::None,
        1 => {
            let (start, end, _) = anchors[0];
            let file_indent = first_non_blank(&content[start..end])
                .map(leading_ws)
                .unwrap_or("");
            Fuzzy::One {
                start,
                end,
                replacement: reindent(new, old_indent, file_indent),
                strategy: "exact first and last lines, similar body",
            }
        }
        n => Fuzzy::Many(n),
    }
}

pub fn closest_hint(content: &str, needle: &str) -> Option<String> {
    let target = first_non_blank(needle)?.trim();
    if target.chars().count() < 4 {
        return None;
    }
    let mut best: Option<(f64, usize, &str)> = None;
    for (i, line) in content.lines().enumerate() {
        let body = line.trim();
        if body.is_empty() {
            continue;
        }
        let score = similarity(body, target);
        if best.is_none_or(|(s, _, _)| score > s) {
            best = Some((score, i, body));
        }
    }
    let (score, i, body) = best?;
    if score < 0.5 {
        return None;
    }
    let shown: String = body.chars().take(160).collect();
    Some(format!(
        "The closest line to the first line of old_string is line {}: \"{}\".",
        i + 1,
        shown
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn apply(content: &str, old: &str, new: &str) -> Option<(String, &'static str)> {
        match locate(content, old, new) {
            Fuzzy::One {
                start,
                end,
                replacement,
                strategy,
            } => Some((
                format!("{}{}{}", &content[..start], replacement, &content[end..]),
                strategy,
            )),
            _ => None,
        }
    }

    #[test]
    fn matches_with_different_indentation_and_reindents() {
        let content = "fn a() {\n        let x = 1;\n        let y = 2;\n}\n";
        let (out, strategy) = apply(
            content,
            "let x = 1;\nlet y = 2;",
            "let x = 10;\nlet y = 20;",
        )
        .unwrap();
        assert_eq!(
            out,
            "fn a() {\n        let x = 10;\n        let y = 20;\n}\n"
        );
        assert_eq!(strategy, "different indentation");
    }

    #[test]
    fn matches_collapsed_inner_whitespace() {
        let content = "const  a =   1;\nconst b = 2;\n";
        let (out, _) = apply(content, "const a = 1;", "const a = 3;").unwrap();
        assert_eq!(out, "const a = 3;\nconst b = 2;\n");
    }

    #[test]
    fn matches_double_escaped_needle() {
        let content = "line one\nline two\n";
        let (out, strategy) = apply(content, "line one\\nline two", "first\\nsecond").unwrap();
        assert_eq!(out, "first\nsecond\n");
        assert_eq!(strategy, "doubled escape sequences");
    }

    #[test]
    fn anchors_tolerate_small_body_drift() {
        let content =
            "function f() {\n  const value = compute(1);\n  log(value);\n  return value;\n}\n";
        let old = "function f() {\n  const value = compute(2);\n  log(value);\n  return value;\n}";
        let (out, strategy) = apply(content, old, "function f() {\n  return 0;\n}").unwrap();
        assert_eq!(out, "function f() {\n  return 0;\n}\n");
        assert_eq!(strategy, "exact first and last lines, similar body");
    }

    #[test]
    fn anchors_reject_unrelated_bodies() {
        let content = "function f() {\n  alpha();\n  beta();\n  gamma();\n}\n";
        let old = "function f() {\n  completely different;\n  nothing alike here;\n  zzz;\n}";
        assert!(apply(content, old, "x").is_none());
    }

    #[test]
    fn ambiguous_matches_are_reported() {
        let content = "  a();\n  b();\n\n    a();\n    b();\n";
        assert!(matches!(
            locate(content, "a();\nb();", "c();"),
            Fuzzy::Many(2)
        ));
    }

    #[test]
    fn closest_hint_points_at_the_nearest_line() {
        let content = "alpha\nconst handler = makeHandler(options);\nomega\n";
        let hint = closest_hint(content, "const handler = makeHandlr(options)").unwrap();
        assert!(hint.contains("line 2"));
        assert!(closest_hint(content, "zzzzzz qqqqq").is_none());
    }
}
