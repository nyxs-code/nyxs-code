//! macOS key codes for characters. A shortcut names a character ("cmd+a"), but macOS events take
//! a key code: the key that types "a" depends on the user's keyboard layout (on a French AZERTY
//! it is where a US keyboard has "q"). The map comes from the layout in use (macos.rs reads it
//! through UCKeyTranslate); the US layout's codes are the fallback, which is also what macOS
//! itself uses for shortcuts when the layout types no Latin letters.

use std::collections::HashMap;

/// The key that types each character, and whether it needs shift.
pub(crate) type CharKeys = HashMap<char, (u16, bool)>;

/// Key codes of the keys that type characters: the letter, digit and punctuation block, space
/// and the ISO key next to the left shift. Return (0x24) and Tab (0x30) are named keys instead.
fn typing_codes() -> impl Iterator<Item = u16> {
    (0x00..=0x32).filter(|c| *c != 0x24 && *c != 0x30)
}

/// The layout's map, from `types(code, shift)`: the character that key types, if any. A key
/// that types it without shift wins over one that needs it.
pub(crate) fn layout_keys(types: impl Fn(u16, bool) -> Option<char>) -> CharKeys {
    let mut out = CharKeys::new();
    for shift in [false, true] {
        for code in typing_codes() {
            if let Some(ch) = types(code, shift).filter(|c| !c.is_control()) {
                out.entry(ch).or_insert((code, shift));
            }
        }
    }
    out
}

/// The key for `ch` and whether it needs shift: the layout's when it types it, else the US one.
/// A letter is its key, not the capital: "cmd+S" is cmd and the S key.
pub(crate) fn char_key(ch: char, layout: Option<&CharKeys>) -> Option<(u16, bool)> {
    let letter = ch.is_alphabetic();
    let wanted = if letter {
        ch.to_lowercase().next().unwrap_or(ch)
    } else {
        ch
    };
    if let Some(&(code, shift)) = layout.and_then(|m| m.get(&wanted)) {
        return Some((code, shift && !letter));
    }
    us_char_key(ch)
}

/// The US-layout key that types `ch`, and whether it needs shift.
pub(crate) fn us_char_key(ch: char) -> Option<(u16, bool)> {
    let lower = ch.to_ascii_lowercase();
    let code = match lower {
        'a' => 0x00,
        's' => 0x01,
        'd' => 0x02,
        'f' => 0x03,
        'h' => 0x04,
        'g' => 0x05,
        'z' => 0x06,
        'x' => 0x07,
        'c' => 0x08,
        'v' => 0x09,
        'b' => 0x0B,
        'q' => 0x0C,
        'w' => 0x0D,
        'e' => 0x0E,
        'r' => 0x0F,
        'y' => 0x10,
        't' => 0x11,
        'o' => 0x1F,
        'u' => 0x20,
        'i' => 0x22,
        'p' => 0x23,
        'l' => 0x25,
        'j' => 0x26,
        'k' => 0x28,
        'n' => 0x2D,
        'm' => 0x2E,
        _ => 0xFFFF,
    };
    if code != 0xFFFF {
        return Some((code, false));
    }
    let (code, shift) = match ch {
        '1' => (0x12, false),
        '2' => (0x13, false),
        '3' => (0x14, false),
        '4' => (0x15, false),
        '5' => (0x17, false),
        '6' => (0x16, false),
        '7' => (0x1A, false),
        '8' => (0x1C, false),
        '9' => (0x19, false),
        '0' => (0x1D, false),
        '!' => (0x12, true),
        '@' => (0x13, true),
        '#' => (0x14, true),
        '$' => (0x15, true),
        '%' => (0x17, true),
        '^' => (0x16, true),
        '&' => (0x1A, true),
        '*' => (0x1C, true),
        '(' => (0x19, true),
        ')' => (0x1D, true),
        '=' => (0x18, false),
        '+' => (0x18, true),
        '-' => (0x1B, false),
        '_' => (0x1B, true),
        '[' => (0x21, false),
        '{' => (0x21, true),
        ']' => (0x1E, false),
        '}' => (0x1E, true),
        '\\' => (0x2A, false),
        '|' => (0x2A, true),
        ';' => (0x29, false),
        ':' => (0x29, true),
        '\'' => (0x27, false),
        '"' => (0x27, true),
        ',' => (0x2B, false),
        '<' => (0x2B, true),
        '.' => (0x2F, false),
        '>' => (0x2F, true),
        '/' => (0x2C, false),
        '?' => (0x2C, true),
        '`' => (0x32, false),
        '~' => (0x32, true),
        ' ' => (0x31, false),
        _ => return None,
    };
    Some((code, shift))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A French AZERTY Mac keyboard, the keys that matter here: A and Q swap, Z and W swap, M sits
    /// where US has ";", the digits need shift, and "é" is on the 2 key.
    fn azerty(code: u16, shift: bool) -> Option<char> {
        let (plain, shifted) = match code {
            0x00 => ('q', 'Q'),
            0x0C => ('a', 'A'),
            0x06 => ('w', 'W'),
            0x0D => ('z', 'Z'),
            0x29 => ('m', 'M'),
            0x2E => (',', '?'),
            0x08 => ('c', 'C'),
            0x12 => ('&', '1'),
            0x13 => ('é', '2'),
            0x31 => (' ', ' '),
            0x24 => ('\r', '\r'),
            _ => return None,
        };
        Some(if shift { shifted } else { plain })
    }

    #[test]
    fn shortcuts_follow_the_layout_in_use() {
        let fr = layout_keys(azerty);
        // cmd+a on AZERTY is the key US calls "q", not the one that quits.
        assert_eq!(char_key('a', Some(&fr)), Some((0x0C, false)));
        assert_eq!(char_key('A', Some(&fr)), Some((0x0C, false)));
        assert_eq!(char_key('z', Some(&fr)), Some((0x0D, false)));
        assert_eq!(char_key('m', Some(&fr)), Some((0x29, false)));
        assert_eq!(char_key('1', Some(&fr)), Some((0x12, true)));
        assert_eq!(char_key('&', Some(&fr)), Some((0x12, false)));
        assert_eq!(char_key('é', Some(&fr)), Some((0x13, false)));
        // The same character on two keys: the one without shift.
        assert_eq!(char_key(' ', Some(&fr)), Some((0x31, false)));
        // Return isn't a typing key, and control characters never map.
        assert!(!fr.values().any(|(code, _)| *code == 0x24));
    }

    #[test]
    fn falls_back_to_the_us_layout() {
        let fr = layout_keys(azerty);
        // Not on the fake layout: the US key.
        assert_eq!(char_key('/', Some(&fr)), Some((0x2C, false)));
        assert_eq!(char_key('a', None), Some((0x00, false)));
        assert_eq!(char_key('+', None), Some((0x18, true)));
        assert_eq!(char_key('€', None), None);
    }
}
