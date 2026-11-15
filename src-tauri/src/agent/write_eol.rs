//! Line endings for a Write over a file that already exists. A file with one kind of line ending
//! gets it everywhere, as before. A file that mixes them on purpose (CRLF code with an LF heredoc,
//! say) keeps each unchanged line's own ending: the new text is matched line by line against the
//! old one, and only new or changed lines take the file's usual ending.

use super::text_io::match_eol;

/// Past this many line pairs left to compare once the shared start and end are set aside, the
/// lines in between aren't matched (it would take too long) and take the usual ending.
const MAX_DIFF_CELLS: usize = 4_000_000;

/// `new` with the line endings it gets when it replaces `old`; `crlf` is `old`'s usual ending.
pub(crate) fn with_old_eols(old: &str, new: &str, crlf: bool) -> String {
    let has_crlf = old.contains("\r\n");
    let has_lf = old.replace("\r\n", "").contains('\n');
    if !(has_crlf && has_lf) {
        return match_eol(new, crlf);
    }
    let old_lines = split_lines(old);
    let new_lf = match_eol(new, false);
    let new_lines = split_lines(&new_lf);
    let matched = match_lines(&old_lines, &new_lines);
    let usual = if crlf { "\r\n" } else { "\n" };
    let mut out = String::with_capacity(new.len() + new_lines.len());
    for (i, line) in new_lines.iter().enumerate() {
        out.push_str(line.text);
        if line.eol.is_empty() {
            continue;
        }
        // A kept line that ended the old file without a newline takes the usual one.
        let eol = matched[i]
            .map(|j| old_lines[j].eol)
            .filter(|e| !e.is_empty())
            .unwrap_or(usual);
        out.push_str(eol);
    }
    out
}

struct Line<'a> {
    text: &'a str,
    /// `"\r\n"`, `"\n"`, or `""` for a last line without one.
    eol: &'a str,
}

fn split_lines(s: &str) -> Vec<Line<'_>> {
    let mut out = Vec::new();
    let mut rest = s;
    while !rest.is_empty() {
        match rest.find('\n') {
            Some(i) => {
                let (text, eol) = if i > 0 && rest.as_bytes()[i - 1] == b'\r' {
                    (&rest[..i - 1], &rest[i - 1..=i])
                } else {
                    (&rest[..i], &rest[i..=i])
                };
                out.push(Line { text, eol });
                rest = &rest[i + 1..];
            }
            None => {
                out.push(Line {
                    text: rest,
                    eol: "",
                });
                rest = "";
            }
        }
    }
    out
}

/// For each new line, the old line it is (a longest common subsequence of the two, by text).
fn match_lines(old: &[Line], new: &[Line]) -> Vec<Option<usize>> {
    let mut matched = vec![None; new.len()];
    let prefix = old
        .iter()
        .zip(new)
        .take_while(|(a, b)| a.text == b.text)
        .count();
    for (i, m) in matched.iter_mut().enumerate().take(prefix) {
        *m = Some(i);
    }
    let suffix = old[prefix..]
        .iter()
        .rev()
        .zip(new[prefix..].iter().rev())
        .take_while(|(a, b)| a.text == b.text)
        .count();
    for k in 0..suffix {
        matched[new.len() - 1 - k] = Some(old.len() - 1 - k);
    }
    let (o, n) = (
        &old[prefix..old.len() - suffix],
        &new[prefix..new.len() - suffix],
    );
    if o.is_empty() || n.is_empty() || o.len().saturating_mul(n.len()) > MAX_DIFF_CELLS {
        return matched;
    }
    // lcs[i][j]: the longest common run of o[i..] and n[j..], in one flat row-major table.
    let w = n.len() + 1;
    let mut lcs = vec![0u32; (o.len() + 1) * w];
    for i in (0..o.len()).rev() {
        for j in (0..n.len()).rev() {
            lcs[i * w + j] = if o[i].text == n[j].text {
                lcs[(i + 1) * w + j + 1] + 1
            } else {
                lcs[(i + 1) * w + j].max(lcs[i * w + j + 1])
            };
        }
    }
    let (mut i, mut j) = (0, 0);
    while i < o.len() && j < n.len() {
        if o[i].text == n[j].text {
            matched[prefix + j] = Some(prefix + i);
            i += 1;
            j += 1;
        } else if lcs[(i + 1) * w + j] >= lcs[i * w + j + 1] {
            i += 1;
        } else {
            j += 1;
        }
    }
    matched
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_changed_line_in_a_mixed_file_leaves_the_rest_as_it_was() {
        let old = "x\r\ncat <<EOF\nlf 1\nlf 2\nEOF\r\ny\r\n";
        let new = "x\ncat <<EOF\nlf 1 changed\nlf 2\nEOF\ny\n";
        assert_eq!(
            with_old_eols(old, new, true),
            "x\r\ncat <<EOF\nlf 1 changed\r\nlf 2\nEOF\r\ny\r\n"
        );
    }

    #[test]
    fn added_and_removed_lines_in_a_mixed_file() {
        let old = "a\r\nb\r\nheredoc 1\nheredoc 2\nc\r\nd\r\n";
        // b removed, a line added inside the LF part and one at the end.
        let new = "a\r\nheredoc 1\nnew lf?\nheredoc 2\nc\nd\ne\n";
        assert_eq!(
            with_old_eols(old, new, true),
            "a\r\nheredoc 1\nnew lf?\r\nheredoc 2\nc\r\nd\r\ne\r\n"
        );
        // Mostly LF: new lines get LF, the one CRLF line keeps it.
        let old = "a\nwin\r\nb\nc\n";
        let new = "a\nwin\nb\nadded\n";
        assert_eq!(with_old_eols(old, new, false), "a\nwin\r\nb\nadded\n");
    }

    #[test]
    fn a_kept_last_line_without_newline_gets_the_usual_one_when_lines_follow() {
        let old = "a\r\nb\nlast";
        assert_eq!(
            with_old_eols(old, "a\nb\nlast\nmore", true),
            "a\r\nb\nlast\r\nmore"
        );
    }

    #[test]
    fn single_ending_files_behave_as_before() {
        // Only LF: everything LF, whatever the new text brings.
        assert_eq!(with_old_eols("a\nb\n", "a\r\nb\nc\r\n", false), "a\nb\nc\n");
        // Only CRLF: everything CRLF.
        assert_eq!(
            with_old_eols("a\r\nb\r\n", "a\nb\r\nc\n", true),
            "a\r\nb\r\nc\r\n"
        );
        // No line ending at all: the usual one.
        assert_eq!(with_old_eols("one line", "one\ntwo\n", false), "one\ntwo\n");
        for (old, new, crlf) in [("a\nb\n", "x\ny", false), ("a\r\nb\r\n", "x\r\ny\n", true)] {
            assert_eq!(with_old_eols(old, new, crlf), match_eol(new, crlf));
        }
    }

    #[test]
    fn repeated_lines_match_in_order() {
        let old = "}\r\n}\n}\r\n";
        assert_eq!(
            with_old_eols(old, "}\n}\nx\n}\n", true),
            "}\r\n}\nx\r\n}\r\n"
        );
    }
}
