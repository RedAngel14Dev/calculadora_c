(() => {
  const expressionElement = document.querySelector("#expression");
  const resultElement = document.querySelector("#result");
  const modeLabel = document.querySelector("#display-mode");
  const statusLabel = document.querySelector("#display-status");
  const modeButtons = [...document.querySelectorAll("[data-mode]")];
  let expression = "";
  let angleMode = "DEG";
  let justEvaluated = false;

  function tokenize(source) {
    const tokens = [];
    let index = 0;
    while (index < source.length) {
      if (/\s/.test(source[index])) { index++; continue; }
      const rest = source.slice(index);
      const number = rest.match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i);
      const identifier = rest.match(/^[a-zA-Z]+/);
      if (number) {
        tokens.push({ type: "number", value: Number(number[0]) });
        index += number[0].length;
      } else if (identifier) {
        tokens.push({ type: "identifier", value: identifier[0].toLowerCase() });
        index += identifier[0].length;
      } else if ("+-*/^()%!".includes(source[index])) {
        tokens.push({ type: "symbol", value: source[index++] });
      } else {
        throw new Error("Carácter no válido");
      }
    }
    return tokens;
  }

  function evaluate(source) {
    const tokens = tokenize(source);
    let position = 0;
    const peek = () => tokens[position];
    const take = (value) => {
      if (peek()?.value === value) { position++; return true; }
      return false;
    };
    const requireFinite = (value) => {
      if (!Number.isFinite(value)) throw new Error("Resultado fuera de rango");
      return value;
    };
    const parseExpression = () => {
      let value = parseTerm();
      while (peek()?.value === "+" || peek()?.value === "-") {
        const operator = tokens[position++].value;
        const right = parseTerm();
        value = requireFinite(operator === "+" ? value + right : value - right);
      }
      return value;
    };
    const startsValue = (token) => token && (
      token.type === "number" || token.type === "identifier" || token.value === "("
    );
    const parseTerm = () => {
      let value = parseUnary();
      while (peek()?.value === "*" || peek()?.value === "/" || startsValue(peek())) {
        const operator = peek()?.value === "*" || peek()?.value === "/" ? tokens[position++].value : "*";
        const right = parseUnary();
        if (operator === "/" && right === 0) throw new Error("No se puede dividir entre cero");
        value = requireFinite(operator === "/" ? value / right : value * right);
      }
      return value;
    };
    const parseUnary = () => {
      if (take("+")) return parseUnary();
      if (take("-")) return requireFinite(-parseUnary());
      return parsePower();
    };
    const parsePower = () => {
      const value = parsePostfix();
      if (take("^")) return requireFinite(value ** parseUnary());
      return value;
    };
    const parsePostfix = () => {
      let value = parsePrimary();
      while (peek()?.value === "!" || peek()?.value === "%") {
        if (take("%")) {
          value /= 100;
        } else {
          take("!");
          if (!Number.isInteger(value) || value < 0 || value > 170) {
            throw new Error("El factorial requiere un entero de 0 a 170");
          }
          let factorial = 1;
          for (let i = 2; i <= value; i++) factorial *= i;
          value = factorial;
        }
        requireFinite(value);
      }
      return value;
    };
    const parsePrimary = () => {
      const token = tokens[position++];
      if (!token) throw new Error("Expresión incompleta");
      if (token.type === "number") return token.value;
      if (token.value === "(") {
        const value = parseExpression();
        if (!take(")")) throw new Error("Falta cerrar un paréntesis");
        return value;
      }
      if (token.type === "identifier") {
        if (token.value === "pi") return Math.PI;
        if (token.value === "e") return Math.E;
        const functions = {
          sin: (x) => Math.sin(angleMode === "DEG" ? x * Math.PI / 180 : x),
          cos: (x) => Math.cos(angleMode === "DEG" ? x * Math.PI / 180 : x),
          tan: (x) => Math.tan(angleMode === "DEG" ? x * Math.PI / 180 : x),
          asin: (x) => angleMode === "DEG" ? Math.asin(x) * 180 / Math.PI : Math.asin(x),
          acos: (x) => angleMode === "DEG" ? Math.acos(x) * 180 / Math.PI : Math.acos(x),
          atan: (x) => angleMode === "DEG" ? Math.atan(x) * 180 / Math.PI : Math.atan(x),
          sqrt: Math.sqrt,
          cbrt: Math.cbrt,
          log: Math.log10,
          ln: Math.log,
          abs: Math.abs
        };
        const fn = functions[token.value];
        if (!fn) throw new Error("Función desconocida");
        if (!take("(")) throw new Error("La función necesita paréntesis");
        const argument = parseExpression();
        if (!take(")")) throw new Error("Falta cerrar un paréntesis");
        return requireFinite(fn(argument));
      }
      throw new Error("Expresión inválida");
    };

    if (tokens.length === 0) throw new Error("Escribe una operación");
    const value = parseExpression();
    if (position !== tokens.length) throw new Error("Revisa la expresión");
    return requireFinite(value);
  }

  function format(value) {
    if (Object.is(value, -0)) value = 0;
    return Number(value.toPrecision(12)).toString();
  }

  function render(showError = false) {
    expressionElement.textContent = expression || " ";
    resultElement.classList.remove("error");
    if (!expression) {
      resultElement.textContent = "0";
      statusLabel.textContent = "LISTA";
      return;
    }
    try {
      resultElement.textContent = format(evaluate(expression));
      statusLabel.textContent = justEvaluated ? "RESULTADO" : "VISTA PREVIA";
    } catch (error) {
      resultElement.textContent = showError ? error.message : "—";
      resultElement.classList.toggle("error", showError);
      statusLabel.textContent = showError ? "ERROR" : "EN CURSO";
    }
  }

  function insert(value) {
    if (justEvaluated && /^(?:\d|\.|pi|e|[a-z])/.test(value)) expression = "";
    justEvaluated = false;
    expression += value;
    render();
  }

  function calculate() {
    if (!expression) return;
    try {
      expression = format(evaluate(expression));
      justEvaluated = true;
      render();
    } catch {
      render(true);
    }
  }

  document.querySelector(".keypad").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.dataset.insert !== undefined) insert(button.dataset.insert);
    if (button.dataset.action === "clear") {
      expression = "";
      justEvaluated = false;
      render();
    }
    if (button.dataset.action === "backspace") {
      if (justEvaluated) expression = "";
      else expression = expression.slice(0, -1);
      justEvaluated = false;
      render();
    }
    if (button.dataset.action === "equals") calculate();
    if (button.dataset.action === "sign") {
      if (justEvaluated) {
        expression = `-(${expression})`;
      } else if (expression.startsWith("-(") && expression.endsWith(")")) {
        expression = expression.slice(2, -1);
      } else if (expression) {
        expression = `-(${expression})`;
      } else {
        expression = "-";
      }
      justEvaluated = false;
      render();
    }
  });

  modeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      angleMode = button.dataset.mode;
      modeButtons.forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
      modeLabel.textContent = angleMode;
      render();
    });
  });

  document.addEventListener("keydown", (event) => {
    if (/^[0-9.+\-*/^()%!]$/.test(event.key)) {
      event.preventDefault();
      insert(event.key);
    } else if (event.key === "Enter" || event.key === "=") {
      event.preventDefault();
      calculate();
    } else if (event.key === "Backspace") {
      event.preventDefault();
      document.querySelector('[data-action="backspace"]').click();
    } else if (event.key === "Escape") {
      document.querySelector('[data-action="clear"]').click();
    }
  });
})();
