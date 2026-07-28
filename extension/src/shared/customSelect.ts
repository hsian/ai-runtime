import "./customSelect.css";

const controls = new WeakMap<HTMLSelectElement, CustomSelect>();
let activeControl: CustomSelect | null = null;

class CustomSelect {
  private root: HTMLDivElement;
  private trigger: HTMLButtonElement;
  private value: HTMLSpanElement;
  private listbox: HTMLDivElement;
  private observer: MutationObserver;

  constructor(private select: HTMLSelectElement) {
    this.root = document.createElement("div");
    this.root.className = "custom-select";

    this.trigger = document.createElement("button");
    this.trigger.type = "button";
    this.trigger.className = "custom-select-trigger";
    this.trigger.setAttribute("aria-haspopup", "listbox");
    this.trigger.setAttribute("aria-expanded", "false");

    this.value = document.createElement("span");
    this.value.className = "custom-select-value";
    this.trigger.appendChild(this.value);

    this.listbox = document.createElement("div");
    this.listbox.className = "custom-select-options";
    this.listbox.id = `custom-select-options-${select.id || crypto.randomUUID()}`;
    this.listbox.setAttribute("role", "listbox");
    this.listbox.hidden = true;
    this.trigger.setAttribute("aria-controls", this.listbox.id);

    this.root.append(this.trigger, this.listbox);
    this.select.classList.add("custom-select-native");
    this.select.setAttribute("aria-hidden", "true");
    this.select.insertAdjacentElement("afterend", this.root);

    this.trigger.addEventListener("click", () => {
      if (this.listbox.hidden) this.open(false);
      else this.close();
    });
    this.trigger.addEventListener("keydown", (event) => this.handleTriggerKeydown(event));
    this.listbox.addEventListener("keydown", (event) => this.handleListboxKeydown(event));
    this.select.addEventListener("change", () => this.refresh());
    this.select.addEventListener("custom-select:sync", () => this.refresh());

    document.addEventListener("pointerdown", (event) => {
      if (!this.root.contains(event.target as Node)) this.close();
    });
    window.addEventListener("resize", () => {
      if (!this.listbox.hidden) this.positionListbox();
    });
    document.addEventListener(
      "scroll",
      (event) => {
        if (!this.listbox.hidden && !this.listbox.contains(event.target as Node)) {
          this.positionListbox();
        }
      },
      true
    );

    this.observer = new MutationObserver(() => this.refresh());
    this.observer.observe(this.select, {
      attributes: true,
      attributeFilter: ["disabled"],
      childList: true,
      subtree: true,
    });
    this.refresh();
  }

  refresh(): void {
    const selected = this.select.options[this.select.selectedIndex];
    this.value.textContent = selected?.textContent?.trim() || "请选择";
    this.trigger.disabled = this.select.disabled;
    this.root.classList.toggle("is-disabled", this.select.disabled);
    if (this.select.disabled) this.close();

    this.listbox.replaceChildren(
      ...Array.from(this.select.options).map((option, index) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "custom-select-option";
        item.dataset.index = String(index);
        item.setAttribute("role", "option");
        item.setAttribute("aria-selected", String(index === this.select.selectedIndex));
        item.disabled = option.disabled;
        item.title = option.textContent?.trim() ?? "";

        const label = document.createElement("span");
        label.className = "custom-select-option-label";
        label.textContent = option.textContent?.trim() ?? "";
        item.appendChild(label);

        if (index === this.select.selectedIndex) {
          const check = document.createElement("span");
          check.className = "custom-select-check";
          check.setAttribute("aria-hidden", "true");
          check.textContent = "✓";
          item.appendChild(check);
        }

        item.addEventListener("click", () => {
          if (option.disabled) return;
          this.select.selectedIndex = index;
          this.select.dispatchEvent(new Event("input", { bubbles: true }));
          this.select.dispatchEvent(new Event("change", { bubbles: true }));
          this.refresh();
          this.close();
          this.trigger.focus();
        });
        return item;
      })
    );

    if (!this.listbox.hidden) {
      requestAnimationFrame(() => this.positionListbox());
    }
  }

  private open(fromKeyboard: boolean): void {
    if (this.select.disabled) return;
    activeControl?.close();
    activeControl = this;
    this.refresh();
    this.listbox.hidden = false;
    this.root.classList.add("is-open");
    this.trigger.setAttribute("aria-expanded", "true");
    this.positionListbox();

    if (fromKeyboard) {
      requestAnimationFrame(() => {
        const selected =
          this.listbox.querySelector<HTMLButtonElement>('[aria-selected="true"]:not(:disabled)') ??
          this.listbox.querySelector<HTMLButtonElement>(".custom-select-option:not(:disabled)");
        selected?.focus();
      });
    }
  }

  close(): void {
    if (this.listbox.hidden) return;
    this.listbox.hidden = true;
    this.root.classList.remove("is-open");
    this.trigger.setAttribute("aria-expanded", "false");
    if (activeControl === this) activeControl = null;
  }

  private positionListbox(): void {
    if (this.listbox.hidden) return;
    const rect = this.trigger.getBoundingClientRect();
    const padding = 8;
    const availableBelow = window.innerHeight - rect.bottom - padding;
    const availableAbove = rect.top - padding;
    const maxHeight = Math.max(80, Math.min(240, Math.max(availableBelow, availableAbove)));
    const optionContentWidth = Math.max(
      rect.width,
      ...Array.from(this.listbox.querySelectorAll<HTMLElement>(".custom-select-option-label"))
        .map((label) => label.scrollWidth + 38)
    );
    const listboxWidth = this.select.id === "iterationSelect"
      ? Math.min(window.innerWidth - padding * 2, optionContentWidth)
      : rect.width;

    this.listbox.style.left = `${Math.max(padding, Math.min(rect.left, window.innerWidth - listboxWidth - padding))}px`;
    this.listbox.style.width = `${listboxWidth}px`;
    this.listbox.style.maxHeight = `${maxHeight}px`;

    const listHeight = Math.min(this.listbox.scrollHeight, maxHeight);
    const showAbove = availableBelow < Math.min(listHeight, 120) && availableAbove > availableBelow;
    this.listbox.style.top = showAbove
      ? `${Math.max(padding, rect.top - listHeight - 4)}px`
      : `${Math.min(window.innerHeight - listHeight - padding, rect.bottom + 4)}px`;

    this.listbox
      .querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }

  private handleTriggerKeydown(event: KeyboardEvent): void {
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
      event.preventDefault();
      this.open(true);
    }
  }

  private handleListboxKeydown(event: KeyboardEvent): void {
    const options = Array.from(
      this.listbox.querySelectorAll<HTMLButtonElement>(".custom-select-option:not(:disabled)")
    );
    const current = options.indexOf(document.activeElement as HTMLButtonElement);

    if (event.key === "Escape") {
      event.preventDefault();
      this.close();
      this.trigger.focus();
      return;
    }

    let next = current;
    if (event.key === "ArrowDown") next = Math.min(options.length - 1, current + 1);
    else if (event.key === "ArrowUp") next = Math.max(0, current - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = options.length - 1;
    else return;

    event.preventDefault();
    options[next]?.focus();
  }
}

export function enhanceSelects(selects: ArrayLike<HTMLSelectElement>): void {
  for (let index = 0; index < selects.length; index += 1) {
    const select = selects[index];
    if (controls.has(select)) continue;
    controls.set(select, new CustomSelect(select));
  }
}

export function refreshCustomSelect(select: HTMLSelectElement): void {
  controls.get(select)?.refresh();
}
