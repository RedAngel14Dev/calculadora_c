use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};

thread_local! {
    static CELLS: RefCell<BTreeMap<String, String>> = RefCell::new(BTreeMap::new());
    static OUTPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static ERROR: RefCell<String> = const { RefCell::new(String::new()) };
}

#[derive(Clone, Debug)]
enum Token {
    Number(f64),
    Word(String),
    Op(char),
}

#[derive(Clone)]
enum Value {
    Number(f64),
    Range(Vec<String>),
}

fn set_error(message: impl Into<String>) {
    ERROR.with(|value| *value.borrow_mut() = message.into());
}

fn set_output(bytes: Vec<u8>) {
    OUTPUT.with(|value| *value.borrow_mut() = bytes);
}

fn input<'a>(ptr: *const u8, len: usize) -> Result<&'a str, String> {
    if len == 0 {
        return Ok("");
    }
    if ptr.is_null() && len != 0 {
        return Err("Entrada vacía o inválida".into());
    }
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    std::str::from_utf8(bytes).map_err(|_| "El texto no es UTF-8".into())
}

fn tokenize(source: &str) -> Result<Vec<Token>, String> {
    let chars: Vec<char> = source.chars().collect();
    let mut tokens = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_whitespace() {
            i += 1;
            continue;
        }
        if chars[i].is_ascii_digit() || chars[i] == '.' {
            let start = i;
            i += 1;
            while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == '.') {
                i += 1;
            }
            if i < chars.len() && matches!(chars[i], 'e' | 'E') {
                i += 1;
                if i < chars.len() && matches!(chars[i], '+' | '-') {
                    i += 1;
                }
                let exponent_start = i;
                while i < chars.len() && chars[i].is_ascii_digit() {
                    i += 1;
                }
                if exponent_start == i {
                    return Err("Exponente incompleto".into());
                }
            }
            let value: String = chars[start..i].iter().collect();
            let number = value.parse::<f64>().map_err(|_| "Número inválido")?;
            if !number.is_finite() {
                return Err("Número fuera de rango".into());
            }
            tokens.push(Token::Number(number));
        } else if chars[i].is_ascii_alphabetic() || chars[i] == '_' {
            let start = i;
            i += 1;
            while i < chars.len() && (chars[i].is_ascii_alphanumeric() || chars[i] == '_') {
                i += 1;
            }
            tokens.push(Token::Word(
                chars[start..i]
                    .iter()
                    .collect::<String>()
                    .to_ascii_lowercase(),
            ));
        } else if "+-*/^()%!:,".contains(chars[i]) {
            tokens.push(Token::Op(chars[i]));
            i += 1;
        } else {
            return Err(format!("Carácter no válido: {}", chars[i]));
        }
    }
    Ok(tokens)
}

struct Parser<'a> {
    tokens: Vec<Token>,
    position: usize,
    angle_mode: u32,
    x: f64,
    allow_x: bool,
    visiting: BTreeSet<String>,
    cells: &'a BTreeMap<String, String>,
}

impl<'a> Parser<'a> {
    fn new(
        source: &str,
        angle_mode: u32,
        x: f64,
        allow_x: bool,
        cells: &'a BTreeMap<String, String>,
    ) -> Result<Self, String> {
        Ok(Self {
            tokens: tokenize(source)?,
            position: 0,
            angle_mode,
            x,
            allow_x,
            visiting: BTreeSet::new(),
            cells,
        })
    }

    fn peek_op(&self, value: char) -> bool {
        matches!(self.tokens.get(self.position), Some(Token::Op(op)) if *op == value)
    }

    fn take_op(&mut self, value: char) -> bool {
        if self.peek_op(value) {
            self.position += 1;
            true
        } else {
            false
        }
    }

    fn parse(mut self) -> Result<f64, String> {
        if self.tokens.is_empty() {
            return Err("Escribe una expresión".into());
        }
        let value = self.expression()?;
        if self.position != self.tokens.len() {
            return Err("Revisa la expresión".into());
        }
        match value {
            Value::Number(number) if number.is_finite() => Ok(number),
            Value::Number(_) => Err("Resultado fuera de rango".into()),
            Value::Range(_) => Err("Se necesita un valor numérico".into()),
        }
    }

    fn expression(&mut self) -> Result<Value, String> {
        let mut left = self.term()?;
        loop {
            let op = if self.take_op('+') {
                '+'
            } else if self.take_op('-') {
                '-'
            } else {
                break;
            };
            let a = Self::number(left)?;
            let b = Self::number(self.term()?)?;
            left = Value::Number(if op == '+' { a + b } else { a - b });
        }
        Ok(left)
    }

    fn starts_value(&self) -> bool {
        matches!(
            self.tokens.get(self.position),
            Some(Token::Number(_) | Token::Word(_))
        ) || self.peek_op('(')
    }

    fn term(&mut self) -> Result<Value, String> {
        let mut left = self.unary()?;
        loop {
            let explicit = self.peek_op('*') || self.peek_op('/');
            if !explicit && !self.starts_value() {
                break;
            }
            let op = if explicit {
                match self.tokens[self.position] {
                    Token::Op(value) => value,
                    _ => '*',
                }
            } else {
                '*'
            };
            if explicit {
                self.position += 1;
            }
            let a = Self::number(left)?;
            let b = Self::number(self.unary()?)?;
            if op == '/' && b == 0.0 {
                return Err("No se puede dividir entre cero".into());
            }
            left = Value::Number(if op == '/' { a / b } else { a * b });
        }
        Ok(left)
    }

    fn unary(&mut self) -> Result<Value, String> {
        if self.take_op('+') {
            return self.unary();
        }
        if self.take_op('-') {
            return Ok(Value::Number(-Self::number(self.unary()?)?));
        }
        self.power()
    }

    fn power(&mut self) -> Result<Value, String> {
        let mut value = self.primary()?;
        if self.take_op('^') {
            value = Value::Number(Self::number(value)?.powf(Self::number(self.unary()?)?));
        }
        loop {
            if self.take_op('%') {
                value = Value::Number(Self::number(value)? / 100.0);
            } else if self.take_op('!') {
                let number = Self::number(value)?;
                if number.fract() != 0.0 || !(0.0..=170.0).contains(&number) {
                    return Err("El factorial requiere un entero de 0 a 170".into());
                }
                let mut factorial = 1.0;
                for n in 2..=(number as u32) {
                    factorial *= n as f64;
                }
                value = Value::Number(factorial);
            } else {
                break;
            }
        }
        Ok(value)
    }

    fn primary(&mut self) -> Result<Value, String> {
        let token = self
            .tokens
            .get(self.position)
            .cloned()
            .ok_or("Expresión incompleta")?;
        self.position += 1;
        match token {
            Token::Number(value) => Ok(Value::Number(value)),
            Token::Op('(') => {
                let value = self.expression()?;
                if !self.take_op(')') {
                    return Err("Falta cerrar un paréntesis".into());
                }
                Ok(value)
            }
            Token::Word(name) if name == "x" && self.allow_x => Ok(Value::Number(self.x)),
            Token::Word(name) if name == "pi" => {
                if self.take_op('(') && !self.take_op(')') {
                    return Err("PI no acepta argumentos".into());
                }
                Ok(Value::Number(std::f64::consts::PI))
            }
            Token::Word(name) if name == "e" => Ok(Value::Number(std::f64::consts::E)),
            Token::Word(name) => {
                if is_cell_address(&name) {
                    if self.take_op(':') {
                        let end = match self.tokens.get(self.position).cloned() {
                            Some(Token::Word(end)) if is_cell_address(&end) => {
                                self.position += 1;
                                end.to_ascii_uppercase()
                            }
                            _ => return Err("#REF!".into()),
                        };
                        return Ok(Value::Range(range_addresses(
                            &name.to_ascii_uppercase(),
                            &end,
                        )?));
                    }
                    return self
                        .resolve_cell(&name.to_ascii_uppercase())
                        .map(Value::Number);
                }
                if !self.take_op('(') {
                    return Err(format!("La función {name} necesita paréntesis"));
                }
                let mut args = Vec::new();
                if !self.take_op(')') {
                    loop {
                        args.push(self.expression()?);
                        if self.take_op(')') {
                            break;
                        }
                        if !self.take_op(',') {
                            return Err("Se esperaba una coma o paréntesis de cierre".into());
                        }
                    }
                }
                self.call_function(&name, args)
            }
            Token::Op(_) => Err("Expresión inválida".into()),
        }
    }

    fn call_function(&mut self, name: &str, args: Vec<Value>) -> Result<Value, String> {
        let values = args
            .iter()
            .map(|value| match value {
                Value::Number(number) => Ok(vec![*number]),
                Value::Range(addresses) => addresses
                    .iter()
                    .map(|address| self.resolve_cell(address))
                    .collect::<Result<Vec<_>, _>>(),
            })
            .collect::<Result<Vec<_>, _>>()?;
        let flat: Vec<f64> = values.into_iter().flatten().collect();
        let number = |index: usize| -> Result<f64, String> {
            match args.get(index) {
                Some(Value::Number(value)) => Ok(*value),
                _ => Err("Se esperaba un valor numérico".into()),
            }
        };
        let unary = |f: fn(f64) -> f64| -> Result<Value, String> {
            if args.len() != 1 {
                return Err("La función requiere un argumento".into());
            }
            Ok(Value::Number(f(number(0)?)))
        };
        let result = match name {
            "sin" => {
                if args.len() != 1 {
                    return Err("La función requiere un argumento".into());
                }
                let v = number(0)?;
                Ok(Value::Number(if self.angle_mode == 1 {
                    v.to_radians().sin()
                } else {
                    v.sin()
                }))
            }
            "cos" => {
                if args.len() != 1 {
                    return Err("La función requiere un argumento".into());
                }
                let v = number(0)?;
                Ok(Value::Number(if self.angle_mode == 1 {
                    v.to_radians().cos()
                } else {
                    v.cos()
                }))
            }
            "tan" => {
                if args.len() != 1 {
                    return Err("La función requiere un argumento".into());
                }
                let v = number(0)?;
                Ok(Value::Number(if self.angle_mode == 1 {
                    v.to_radians().tan()
                } else {
                    v.tan()
                }))
            }
            "asin" | "acos" | "atan" => {
                if args.len() != 1 {
                    return Err("La función requiere un argumento".into());
                }
                let v = number(0)?;
                let out = match name {
                    "asin" => v.asin(),
                    "acos" => v.acos(),
                    _ => v.atan(),
                };
                Ok(Value::Number(if self.angle_mode == 1 {
                    out.to_degrees()
                } else {
                    out
                }))
            }
            "sqrt" => unary(f64::sqrt),
            "cbrt" => unary(f64::cbrt),
            "log" => unary(f64::log10),
            "ln" => unary(f64::ln),
            "abs" => unary(f64::abs),
            "exp" => unary(f64::exp),
            "pi" => {
                if !args.is_empty() {
                    return Err("PI no acepta argumentos".into());
                }
                Ok(Value::Number(std::f64::consts::PI))
            }
            "sum" => Ok(Value::Number(flat.iter().sum())),
            "product" => Ok(Value::Number(flat.iter().product())),
            "average" | "avg" => {
                if flat.is_empty() {
                    return Err("Promedio de un rango vacío".into());
                }
                Ok(Value::Number(flat.iter().sum::<f64>() / flat.len() as f64))
            }
            "min" => Ok(Value::Number(
                flat.iter().copied().reduce(f64::min).unwrap_or(0.0),
            )),
            "max" => Ok(Value::Number(
                flat.iter().copied().reduce(f64::max).unwrap_or(0.0),
            )),
            "count" => Ok(Value::Number(flat.len() as f64)),
            "round" => {
                if args.is_empty() || args.len() > 2 {
                    return Err("ROUND requiere uno o dos argumentos".into());
                }
                let decimals = if args.len() == 2 { number(1)? } else { 0.0 };
                let factor = 10_f64.powf(decimals);
                Ok(Value::Number((number(0)? * factor).round() / factor))
            }
            _ => Err(format!("Función desconocida: {name}")),
        }?;
        if matches!(result, Value::Number(v) if !v.is_finite()) {
            return Err("Resultado fuera de rango".into());
        }
        Ok(result)
    }

    fn number(value: Value) -> Result<f64, String> {
        match value {
            Value::Number(value) if value.is_finite() => Ok(value),
            Value::Number(_) => Err("Resultado fuera de rango".into()),
            Value::Range(_) => Err("Se esperaba un valor numérico".into()),
        }
    }

    fn resolve_cell(&mut self, address: &str) -> Result<f64, String> {
        let address = address.to_ascii_uppercase();
        if !self.visiting.insert(address.clone()) {
            return Err("#CIRCULAR!".into());
        }
        let raw = self.cells.get(&address).cloned().unwrap_or_default();
        let result = if raw.is_empty() {
            Ok(0.0)
        } else if let Some(formula) = raw.strip_prefix('=') {
            let mut parser = Parser::new(formula, self.angle_mode, 0.0, false, self.cells)?;
            parser.visiting = self.visiting.clone();
            parser.parse()
        } else if let Ok(value) = raw.parse::<f64>() {
            Ok(value)
        } else {
            Err("#VALOR!".into())
        };
        self.visiting.remove(&address);
        result
    }
}

fn column_number(value: &str) -> Result<usize, String> {
    let mut number = 0usize;
    let mut chars = value.chars().peekable();
    while matches!(chars.peek(), Some(c) if c.is_ascii_alphabetic()) {
        number =
            number * 26 + (chars.next().unwrap().to_ascii_uppercase() as usize - 'A' as usize + 1);
        if number > 16384 {
            return Err("#REF!".into());
        }
    }
    Ok(number)
}

fn is_cell_address(value: &str) -> bool {
    let split = value.find(|c: char| c.is_ascii_digit());
    let Some(split) = split else { return false };
    split > 0
        && value[..split].chars().all(|c| c.is_ascii_alphabetic())
        && !value[split..].is_empty()
        && value[split..].chars().all(|c| c.is_ascii_digit())
        && value[split..].parse::<usize>().is_ok_and(|row| row > 0)
}

fn column_name(mut number: usize) -> String {
    let mut name = String::new();
    while number > 0 {
        number -= 1;
        name.insert(0, char::from(b'A' + (number % 26) as u8));
        number /= 26;
    }
    name
}

fn range_addresses(start: &str, end: &str) -> Result<Vec<String>, String> {
    let parse = |address: &str| -> Result<(usize, usize), String> {
        let split = address.find(|c: char| c.is_ascii_digit()).ok_or("#REF!")?;
        let col = column_number(&address[..split])?;
        let row = address[split..].parse::<usize>().map_err(|_| "#REF!")?;
        if row == 0 || row > 1_048_576 {
            return Err("#REF!".into());
        }
        Ok((col, row))
    };
    let (c1, r1) = parse(start)?;
    let (c2, r2) = parse(end)?;
    let (left, right) = (c1.min(c2), c1.max(c2));
    let (top, bottom) = (r1.min(r2), r1.max(r2));
    if (right - left + 1).saturating_mul(bottom - top + 1) > 10_000 {
        return Err("#RANGO!".into());
    }
    let mut addresses = Vec::new();
    for row in top..=bottom {
        for col in left..=right {
            addresses.push(format!("{}{}", column_name(col), row));
        }
    }
    Ok(addresses)
}

fn evaluate(source: &str, angle_mode: u32, x: f64, allow_x: bool) -> Result<f64, String> {
    CELLS.with(|cells| Parser::new(source, angle_mode, x, allow_x, &cells.borrow())?.parse())
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for byte in data {
        crc ^= *byte as u32;
        for _ in 0..8 {
            crc = if crc & 1 == 1 {
                0xedb8_8320 ^ (crc >> 1)
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

fn put16(out: &mut Vec<u8>, value: u16) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn put32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn zip_store(files: Vec<(&str, Vec<u8>)>) -> Vec<u8> {
    let mut output = Vec::new();
    let mut central = Vec::new();
    for (name, data) in files {
        let name = name.as_bytes();
        let checksum = crc32(&data);
        let offset = output.len() as u32;
        put32(&mut output, 0x0403_4b50);
        put16(&mut output, 20);
        put16(&mut output, 0x0800);
        put16(&mut output, 0);
        put16(&mut output, 0);
        put16(&mut output, 0);
        put32(&mut output, checksum);
        put32(&mut output, data.len() as u32);
        put32(&mut output, data.len() as u32);
        put16(&mut output, name.len() as u16);
        put16(&mut output, 0);
        output.extend_from_slice(name);
        output.extend_from_slice(&data);

        put32(&mut central, 0x0201_4b50);
        put16(&mut central, 20);
        put16(&mut central, 20);
        put16(&mut central, 0x0800);
        put16(&mut central, 0);
        put16(&mut central, 0);
        put16(&mut central, 0);
        put32(&mut central, checksum);
        put32(&mut central, data.len() as u32);
        put32(&mut central, data.len() as u32);
        put16(&mut central, name.len() as u16);
        put16(&mut central, 0);
        put16(&mut central, 0);
        put16(&mut central, 0);
        put16(&mut central, 0);
        put32(&mut central, 0);
        put32(&mut central, offset);
        central.extend_from_slice(name);
    }
    let central_offset = output.len() as u32;
    let central_size = central.len() as u32;
    output.extend_from_slice(&central);
    put32(&mut output, 0x0605_4b50);
    put16(&mut output, 0);
    put16(&mut output, 0);
    let file_count = central_file_count(&central);
    put16(&mut output, file_count);
    put16(&mut output, file_count);
    put32(&mut output, central_size);
    put32(&mut output, central_offset);
    put16(&mut output, 0);
    output
}

fn central_file_count(data: &[u8]) -> u16 {
    let mut count = 0u16;
    let mut offset = 0;
    while offset + 46 <= data.len() && data[offset..offset + 4] == [0x50, 0x4b, 0x01, 0x02] {
        let name = u16::from_le_bytes([data[offset + 28], data[offset + 29]]) as usize;
        let extra = u16::from_le_bytes([data[offset + 30], data[offset + 31]]) as usize;
        let comment = u16::from_le_bytes([data[offset + 32], data[offset + 33]]) as usize;
        offset += 46 + name + extra + comment;
        count = count.saturating_add(1);
    }
    count
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn odf_package(
    mimetype: &str,
    body_xml: &str,
    styles_xml: &str,
    root: &str,
    manifest_type: &str,
) -> Vec<u8> {
    let content = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?><office:document-content xmlns:office=\"urn:oasis:names:tc:opendocument:xmlns:office:1.0\" xmlns:style=\"urn:oasis:names:tc:opendocument:xmlns:style:1.0\" xmlns:text=\"urn:oasis:names:tc:opendocument:xmlns:text:1.0\" xmlns:table=\"urn:oasis:names:tc:opendocument:xmlns:table:1.0\" xmlns:of=\"urn:oasis:names:tc:opendocument:xmlns:of:1.2\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" xmlns:fo=\"urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0\" office:version=\"1.3\"><office:automatic-styles>{styles_xml}</office:automatic-styles><office:body>{root}{body_xml}{}</office:body></office:document-content>",
        if root == "<office:text>" {
            "</office:text>"
        } else {
            "</office:spreadsheet>"
        }
    );
    let manifest = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?><manifest:manifest xmlns:manifest=\"urn:oasis:names:tc:opendocument:xmlns:manifest:1.0\" manifest:version=\"1.3\"><manifest:file-entry manifest:full-path=\"/\" manifest:version=\"1.3\" manifest:media-type=\"{manifest_type}\"/><manifest:file-entry manifest:full-path=\"content.xml\" manifest:media-type=\"text/xml\"/></manifest:manifest>"
    );
    zip_store(vec![
        ("mimetype", mimetype.as_bytes().to_vec()),
        ("content.xml", content.into_bytes()),
        ("META-INF/manifest.xml", manifest.into_bytes()),
    ])
}

fn current_cell_value(address: &str, cells: &BTreeMap<String, String>) -> Result<String, String> {
    let raw = cells.get(address).cloned().unwrap_or_default();
    if let Some(formula) = raw.strip_prefix('=') {
        let parser = Parser::new(formula, 0, 0.0, false, cells)?;
        return parser.parse().map(|value| format_number(value));
    }
    if raw.is_empty() {
        Ok(String::new())
    } else if let Ok(number) = raw.parse::<f64>() {
        Ok(format_number(number))
    } else {
        Ok(raw)
    }
}

fn formula_to_odf(source: &str) -> String {
    let chars: Vec<char> = source.chars().collect();
    let mut output = String::new();
    let mut index = 0;
    while index < chars.len() {
        let start = index;
        if chars[index] == '$' || chars[index].is_ascii_alphabetic() {
            if chars[index] == '$' {
                index += 1;
            }
            while index < chars.len() && chars[index].is_ascii_alphabetic() {
                index += 1;
            }
            if index < chars.len() && chars[index] == '$' {
                index += 1;
            }
            let digit_start = index;
            while index < chars.len() && chars[index].is_ascii_digit() {
                index += 1;
            }
            if digit_start < index {
                let first: String = chars[start..index].iter().filter(|c| **c != '$').collect();
                if index < chars.len() && chars[index] == ':' {
                    let range_start = index;
                    index += 1;
                    let second_start = index;
                    if index < chars.len() && chars[index] == '$' {
                        index += 1;
                    }
                    while index < chars.len() && chars[index].is_ascii_alphabetic() {
                        index += 1;
                    }
                    if index < chars.len() && chars[index] == '$' {
                        index += 1;
                    }
                    let second_digits = index;
                    while index < chars.len() && chars[index].is_ascii_digit() {
                        index += 1;
                    }
                    if second_digits < index {
                        let second: String = chars[second_start..index]
                            .iter()
                            .filter(|c| **c != '$')
                            .collect();
                        output.push_str(&format!("[.{first}:.{second}]"));
                    } else {
                        output.extend(chars[start..range_start].iter());
                        index = range_start;
                    }
                } else {
                    output.push_str(&format!("[.{first}]"));
                }
            } else {
                output.extend(chars[start..index].iter());
            }
        } else {
            output.push(if chars[index] == ',' {
                ';'
            } else {
                chars[index]
            });
            index += 1;
        }
    }
    output
}

fn format_number(value: f64) -> String {
    if value == 0.0 {
        return "0".into();
    }
    format!("{:.10}", value)
        .trim_end_matches('0')
        .trim_end_matches('.')
        .to_string()
}

fn make_ods(cells: &BTreeMap<String, String>) -> Vec<u8> {
    let mut rows = String::new();
    for row in 1..=24 {
        rows.push_str("<table:table-row>");
        for col in 1..=8 {
            let address = format!("{}{}", column_name(col), row);
            let raw = cells.get(&address).cloned().unwrap_or_default();
            if let Some(formula) = raw.strip_prefix('=') {
                let formula = formula_to_odf(formula);
                let value = current_cell_value(&address, cells).unwrap_or_default();
                if let Ok(number) = value.parse::<f64>() {
                    rows.push_str(&format!("<table:table-cell table:formula=\"of:={}\" office:value-type=\"float\" office:value=\"{}\"><text:p>{}</text:p></table:table-cell>", xml_escape(&formula), number, xml_escape(&value)));
                } else {
                    rows.push_str(&format!("<table:table-cell table:formula=\"of:={}\" office:value-type=\"string\"><text:p>{}</text:p></table:table-cell>", xml_escape(&formula), xml_escape(&value)));
                }
            } else if let Ok(number) = raw.parse::<f64>() {
                if !raw.is_empty() {
                    rows.push_str(&format!("<table:table-cell office:value-type=\"float\" office:value=\"{}\"><text:p>{}</text:p></table:table-cell>", number, xml_escape(&raw)));
                } else {
                    rows.push_str("<table:table-cell/>");
                }
            } else if raw.is_empty() {
                rows.push_str("<table:table-cell/>");
            } else {
                rows.push_str(&format!("<table:table-cell office:value-type=\"string\"><text:p>{}</text:p></table:table-cell>", xml_escape(&raw)));
            }
        }
        rows.push_str("</table:table-row>");
    }
    let body = format!(
        "<table:table table:name=\"Hoja1\"><table:table-column table:number-columns-repeated=\"8\"/>{rows}</table:table>"
    );
    odf_package(
        "application/vnd.oasis.opendocument.spreadsheet",
        &body,
        "",
        "<office:spreadsheet>",
        "application/vnd.oasis.opendocument.spreadsheet",
    )
}

fn make_odt(text: &str) -> Vec<u8> {
    let paragraphs = text
        .lines()
        .map(|line| {
            if line.is_empty() {
                "<text:p/>".to_string()
            } else {
                format!("<text:p>{}</text:p>", xml_escape(line))
            }
        })
        .collect::<String>();
    odf_package(
        "application/vnd.oasis.opendocument.text",
        &paragraphs,
        "",
        "<office:text>",
        "application/vnd.oasis.opendocument.text",
    )
}

fn make_odt_xml(body_xml: &str, styles_xml: &str) -> Vec<u8> {
    odf_package(
        "application/vnd.oasis.opendocument.text",
        body_xml,
        styles_xml,
        "<office:text>",
        "application/vnd.oasis.opendocument.text",
    )
}

#[unsafe(no_mangle)]
pub extern "C" fn wasm_alloc(size: usize) -> *mut u8 {
    let mut buffer = Vec::<u8>::with_capacity(size.max(1));
    let ptr = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    ptr
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn wasm_dealloc(ptr: *mut u8, size: usize) {
    if !ptr.is_null() {
        drop(unsafe { Vec::from_raw_parts(ptr, 0, size.max(1)) });
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn wasm_evaluate(
    ptr: *const u8,
    len: usize,
    angle_mode: u32,
    x: f64,
    allow_x: u32,
) -> f64 {
    set_error("");
    match input(ptr, len).and_then(|source| evaluate(source, angle_mode, x, allow_x != 0)) {
        Ok(value) => value,
        Err(message) => {
            set_error(message);
            f64::NAN
        }
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn wasm_set_cell(
    addr_ptr: *const u8,
    addr_len: usize,
    value_ptr: *const u8,
    value_len: usize,
) {
    let result = input(addr_ptr, addr_len).and_then(|addr| {
        let value = input(value_ptr, value_len)?;
        let addr = addr.to_ascii_uppercase();
        let split = addr.find(|c: char| c.is_ascii_digit()).ok_or("#REF!")?;
        let column = column_number(&addr[..split])?;
        let row = addr[split..].parse::<usize>().map_err(|_| "#REF!")?;
        if column == 0 || column > 8 || row == 0 || row > 24 {
            return Err("#REF!".into());
        }
        CELLS.with(|cells| {
            let mut cells = cells.borrow_mut();
            if value.is_empty() {
                cells.remove(&addr);
            } else {
                cells.insert(addr, value.into());
            }
        });
        Ok(())
    });
    if let Err(message) = result {
        set_error(message);
    } else {
        set_error("");
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn wasm_cell_value(addr_ptr: *const u8, addr_len: usize) {
    let result = input(addr_ptr, addr_len).and_then(|addr| {
        CELLS.with(|cells| current_cell_value(&addr.to_ascii_uppercase(), &cells.borrow()))
    });
    match result {
        Ok(value) => {
            set_error("");
            set_output(value.into_bytes());
        }
        Err(message) => {
            set_error(message.clone());
            set_output(message.into_bytes());
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn wasm_clear_sheet() {
    CELLS.with(|cells| cells.borrow_mut().clear());
}

#[unsafe(no_mangle)]
pub extern "C" fn wasm_export_ods() {
    CELLS.with(|cells| set_output(make_ods(&cells.borrow())));
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn wasm_export_odt(ptr: *const u8, len: usize) {
    match input(ptr, len) {
        Ok(text) => {
            set_error("");
            set_output(make_odt(text).into_iter().collect());
        }
        Err(message) => set_error(message),
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn wasm_export_odt_xml(
    body_ptr: *const u8,
    body_len: usize,
    styles_ptr: *const u8,
    styles_len: usize,
) {
    let result = input(body_ptr, body_len).and_then(|body| {
        let styles = input(styles_ptr, styles_len)?;
        Ok(make_odt_xml(body, styles))
    });
    match result {
        Ok(bytes) => {
            set_error("");
            set_output(bytes);
        }
        Err(message) => set_error(message),
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn wasm_word_count(ptr: *const u8, len: usize) -> u32 {
    match input(ptr, len) {
        Ok(text) => text.split_whitespace().count().min(u32::MAX as usize) as u32,
        Err(message) => {
            set_error(message);
            0
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn wasm_output_ptr() -> *const u8 {
    OUTPUT.with(|output| output.borrow().as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn wasm_output_len() -> usize {
    OUTPUT.with(|output| output.borrow().len())
}

#[unsafe(no_mangle)]
pub extern "C" fn wasm_error_ptr() -> *const u8 {
    ERROR.with(|error| error.borrow().as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn wasm_error_len() -> usize {
    ERROR.with(|error| error.borrow().len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expression_and_spreadsheet_smoke_test() {
        assert!((evaluate("sin(30)^2 + cos(30)^2", 1, 0.0, false).unwrap() - 1.0).abs() < 1e-12);
        assert_eq!(evaluate("2(3+4)", 0, 0.0, false).unwrap(), 14.0);
        assert_eq!(evaluate("x^2 + 2x + 1", 0, 3.0, true).unwrap(), 16.0);
        assert_eq!(
            evaluate("sqrt(81) + log(100)", 0, 0.0, false).unwrap(),
            11.0
        );
        assert_eq!(
            evaluate("PI()", 0, 0.0, false).unwrap(),
            std::f64::consts::PI
        );
        assert_eq!(formula_to_odf("SUM(A1:A4, B3)"), "SUM([.A1:.A4]; [.B3])");

        CELLS.with(|cells| {
            let mut cells = cells.borrow_mut();
            cells.clear();
            cells.insert("A1".into(), "4".into());
            cells.insert("A2".into(), "6".into());
            cells.insert("B1".into(), "=SUM(A1:A2)".into());
            cells.insert("B2".into(), "=B1/2".into());
            assert_eq!(current_cell_value("B1", &cells).unwrap(), "10");
            assert_eq!(current_cell_value("B2", &cells).unwrap(), "5");
            cells.insert("C1".into(), "=C1".into());
            assert_eq!(current_cell_value("C1", &cells).unwrap_err(), "#CIRCULAR!");
            cells.clear();
        });
    }

    #[test]
    fn odf_files_are_valid_stored_zip_packages() {
        let odt = make_odt("Hello\nWorld");
        assert_eq!(&odt[..4], b"PK\x03\x04");
        assert_eq!(&odt[30..38], b"mimetype");
        let odt_mime = b"application/vnd.oasis.opendocument.text";
        assert!(odt.windows(odt_mime.len()).any(|window| window == odt_mime));
        let styled_odt = make_odt_xml(
            "<text:p><text:span text:style-name=\"Bold\">Hello</text:span></text:p>",
            "<style:style style:name=\"Bold\" style:family=\"text\"><style:text-properties fo:font-weight=\"bold\"/></style:style>",
        );
        assert!(
            styled_odt
                .windows(odt_mime.len())
                .any(|window| window == odt_mime)
        );

        let mut cells = BTreeMap::new();
        cells.insert("A1".into(), "2".into());
        cells.insert("A2".into(), "=A1+3".into());
        let ods = make_ods(&cells);
        assert_eq!(&ods[..4], b"PK\x03\x04");
        let ods_mime = b"application/vnd.oasis.opendocument.spreadsheet";
        assert!(ods.windows(ods_mime.len()).any(|window| window == ods_mime));
    }
}
