use super::keys::{Key, Modifier};
use super::matcher::Input;

/// Classify one `rdev::Key` into the matcher's vocabulary, or `None` for keys we
/// do not support as bindings. This is the only rdev-coupled code in the module:
/// everything downstream works in our own `Modifier` / `Key` types, which is
/// what lets the matcher be unit-tested without rdev.
///
/// Left/right modifiers collapse here (v1): `ControlLeft` and `ControlRight`
/// both become `Modifier::Ctrl`. `AltGr` folds into `Alt`, which is the v1
/// simplification (on Windows AltGr is physically Ctrl+Alt; splitting it is a
/// documented deferral). `Function` is the macOS/rustdesk Fn key.
pub fn classify(key: rdev::Key) -> Option<Input> {
    use rdev::Key as R;

    let modifier = match key {
        R::ControlLeft | R::ControlRight => Some(Modifier::Ctrl),
        R::ShiftLeft | R::ShiftRight => Some(Modifier::Shift),
        R::Alt | R::AltGr => Some(Modifier::Alt),
        R::MetaLeft | R::MetaRight => Some(Modifier::Meta),
        R::Function => Some(Modifier::Fn),
        _ => None,
    };
    if let Some(modifier) = modifier {
        return Some(Input::Modifier(modifier));
    }

    let mapped = match key {
        R::KeyA => Key::KeyA,
        R::KeyB => Key::KeyB,
        R::KeyC => Key::KeyC,
        R::KeyD => Key::KeyD,
        R::KeyE => Key::KeyE,
        R::KeyF => Key::KeyF,
        R::KeyG => Key::KeyG,
        R::KeyH => Key::KeyH,
        R::KeyI => Key::KeyI,
        R::KeyJ => Key::KeyJ,
        R::KeyK => Key::KeyK,
        R::KeyL => Key::KeyL,
        R::KeyM => Key::KeyM,
        R::KeyN => Key::KeyN,
        R::KeyO => Key::KeyO,
        R::KeyP => Key::KeyP,
        R::KeyQ => Key::KeyQ,
        R::KeyR => Key::KeyR,
        R::KeyS => Key::KeyS,
        R::KeyT => Key::KeyT,
        R::KeyU => Key::KeyU,
        R::KeyV => Key::KeyV,
        R::KeyW => Key::KeyW,
        R::KeyX => Key::KeyX,
        R::KeyY => Key::KeyY,
        R::KeyZ => Key::KeyZ,
        R::Num0 => Key::Num0,
        R::Num1 => Key::Num1,
        R::Num2 => Key::Num2,
        R::Num3 => Key::Num3,
        R::Num4 => Key::Num4,
        R::Num5 => Key::Num5,
        R::Num6 => Key::Num6,
        R::Num7 => Key::Num7,
        R::Num8 => Key::Num8,
        R::Num9 => Key::Num9,
        R::F1 => Key::F1,
        R::F2 => Key::F2,
        R::F3 => Key::F3,
        R::F4 => Key::F4,
        R::F5 => Key::F5,
        R::F6 => Key::F6,
        R::F7 => Key::F7,
        R::F8 => Key::F8,
        R::F9 => Key::F9,
        R::F10 => Key::F10,
        R::F11 => Key::F11,
        R::F12 => Key::F12,
        R::F13 => Key::F13,
        R::F14 => Key::F14,
        R::F15 => Key::F15,
        R::F16 => Key::F16,
        R::F17 => Key::F17,
        R::F18 => Key::F18,
        R::F19 => Key::F19,
        R::F20 => Key::F20,
        R::F21 => Key::F21,
        R::F22 => Key::F22,
        R::F23 => Key::F23,
        R::F24 => Key::F24,
        R::Space => Key::Space,
        R::Return | R::KpReturn => Key::Return,
        R::Tab => Key::Tab,
        R::Escape => Key::Escape,
        R::Backspace => Key::Backspace,
        R::Delete => Key::Delete,
        R::Insert => Key::Insert,
        R::UpArrow => Key::UpArrow,
        R::DownArrow => Key::DownArrow,
        R::LeftArrow => Key::LeftArrow,
        R::RightArrow => Key::RightArrow,
        R::Home => Key::Home,
        R::End => Key::End,
        R::PageUp => Key::PageUp,
        R::PageDown => Key::PageDown,
        R::Minus => Key::Minus,
        R::Equal => Key::Equal,
        R::LeftBracket => Key::LeftBracket,
        R::RightBracket => Key::RightBracket,
        R::SemiColon => Key::SemiColon,
        R::Quote => Key::Quote,
        R::BackQuote => Key::BackQuote,
        R::BackSlash => Key::BackSlash,
        R::Comma => Key::Comma,
        R::Dot => Key::Dot,
        R::Slash => Key::Slash,
        _ => return None,
    };
    Some(Input::Key(mapped))
}
