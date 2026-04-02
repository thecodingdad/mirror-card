/**
 * Mirror Card for Home Assistant
 * ===============================
 * v1.4.0
 *
 * Mirrors (clones) cards from any view of the same dashboard.
 * Supports three levels of mirroring:
 *   - View only:              mirrors all cards from a view
 *   - View + Section:         mirrors all cards from a section
 *   - View + Section + Card:  mirrors a single card
 *
 * Config options:
 *   type: custom:mirror-card
 *   source_view:    0          # view index (number) or view path (string) — required
 *   source_section: null       # optional section index
 *   source_card:    null       # optional card index (within section or flat)
 *   layout:         'native'   # 'native' (original layout), 'stack', or 'grid'
 */

const MIRROR_CARD_VERSION = '1.0.0';

const { t } = await import(`./i18n/index.js?v=${MIRROR_CARD_VERSION}`);

// ── LitElement from HA bundle ───────────────────────────────────────
const LitElement = Object.getPrototypeOf(customElements.get('ha-panel-lovelace'));
const { html, css } = LitElement.prototype;

// ── Lovelace access helpers ─────────────────────────────────────────
function _getHuiRoot() {
  try {
    return document.querySelector('home-assistant')
      ?.shadowRoot?.querySelector('home-assistant-main')
      ?.shadowRoot?.querySelector('partial-panel-resolver')
      ?.querySelector('ha-panel-lovelace')
      ?.shadowRoot?.querySelector('hui-root');
  } catch (_) { return null; }
}

function _getLovelaceConfig() {
  return _getHuiRoot()?.lovelace?.config ?? null;
}

function _getLovelaceObject() {
  return _getHuiRoot()?.lovelace ?? null;
}

// ── Dynamic card creation ───────────────────────────────────────────
function _buildCardElement(cardConfig, hass) {
  if (!cardConfig?.type) return null;
  const type = cardConfig.type;
  const tag  = type.startsWith('custom:') ? type.slice(7) : `hui-${type}-card`;

  if (customElements.get(tag)) {
    const el = document.createElement(tag);
    try { if (typeof el.setConfig === 'function') el.setConfig(cardConfig); } catch (_) {}
    if (hass) el.hass = hass;
    return el;
  }

  if (customElements.get('hui-card')) {
    const el = document.createElement('hui-card');
    try { el.config = cardConfig; } catch (_) {}
    if (hass) el.hass = hass;
    return el;
  }

  let el;
  try { el = document.createElement(tag); } catch (e) {
    console.error(`[mirror-card] Cannot create <${tag}>:`, e);
    return null;
  }
  try { if (typeof el.setConfig === 'function') el.setConfig(cardConfig); } catch (_) {}
  if (hass) el.hass = hass;
  return el;
}

// ── Native section element creation ─────────────────────────────────
function _buildSectionElement(sectionConfig, hass, lovelace, viewIndex, sectionIndex) {
  if (!customElements.get('hui-section')) return null;
  const el = document.createElement('hui-section');
  el.preview = true;
  el.config = sectionConfig;
  el.hass = hass;
  // Always pass editMode: false so mirrored sections never show edit controls
  el.lovelace = { ...lovelace, editMode: false };
  el.viewIndex = viewIndex;
  el.index = sectionIndex;
  return el;
}

// ── Resolve source from lovelace config ─────────────────────────────
// Returns { mode, cards, sectionConfig, viewConfig, viewIndex, sectionIndex } or null.
function _resolveSource(lovelaceConfig, sourceView, sourceSection, sourceCard) {
  if (!lovelaceConfig?.views) return null;
  const views = lovelaceConfig.views;

  // Find view by index or path
  let view = null;
  let viewIndex = -1;
  if (typeof sourceView === 'number') {
    view = views[sourceView] ?? null;
    viewIndex = sourceView;
  } else if (typeof sourceView === 'string') {
    viewIndex = views.findIndex(v => v.path === sourceView || v.title === sourceView);
    view = viewIndex >= 0 ? views[viewIndex] : null;
  }
  if (!view) return null;

  // Level 3: specific section + specific card
  if (sourceSection != null && sourceCard != null) {
    const section = (view.sections ?? [])[sourceSection];
    const card = section?.cards?.[sourceCard];
    return card ? { mode: 'card', cards: [card], viewIndex, sectionIndex: sourceSection } : null;
  }

  // Level 2: specific section, all cards
  if (sourceSection != null && sourceCard == null) {
    const section = (view.sections ?? [])[sourceSection];
    if (!section?.cards?.length) return null;
    return {
      mode: 'section',
      cards: [...section.cards],
      sectionConfig: section,
      viewIndex,
      sectionIndex: sourceSection,
    };
  }

  // Level 1: all cards from view (entire view)
  if (sourceSection == null && sourceCard == null) {
    const allCards = [...(view.cards ?? [])];
    for (const sec of (view.sections ?? [])) {
      allCards.push(...(sec.cards ?? []));
    }
    if (!allCards.length) return null;
    return {
      mode: 'view',
      cards: allCards,
      viewConfig: view,
      viewIndex,
    };
  }

  // Backward compat: no section but specific card (flat index)
  if (sourceSection == null && sourceCard != null) {
    const allCards = [...(view.cards ?? [])];
    for (const sec of (view.sections ?? [])) {
      allCards.push(...(sec.cards ?? []));
    }
    const card = allCards[sourceCard];
    return card ? { mode: 'card', cards: [card], viewIndex } : null;
  }

  return null;
}

// ── Helper: human-readable card label ───────────────────────────────
function _cardLabel(cardConfig, index) {
  if (!cardConfig?.type) return `Card ${index}`;
  const type = cardConfig.type.replace('custom:', '');
  const extra = cardConfig.title
    || cardConfig.name
    || cardConfig.entity
    || cardConfig.header
    || '';
  return extra ? `#${index} ${type} (${extra})` : `#${index} ${type}`;
}

// ── Mirror Card ─────────────────────────────────────────────────────
class MirrorCard extends LitElement {
  static get properties() {
    return {
      hass: { attribute: false },
      _config: { state: true },
    };
  }

  static get styles() {
    return css`
      :host > * { width: 100%; }
    `;
  }

  static getConfigElement() {
    return document.createElement('mirror-card-editor');
  }

  static getStubConfig() {
    return { source_view: 0 };
  }

  constructor() {
    super();
    this._config = null;
    this._cardEl = null;
    this._nativeEls = null;
    this._resolvedConfig = null;
    this._lastLovelaceConfig = null;
  }

  setConfig(config) {
    if (config.source_view == null) throw new Error('[mirror-card] "source_view" is required');
    const layout = config.layout === 'grid' ? 'grid'
      : config.layout === 'stack' ? 'stack'
      : 'native';
    this._config = {
      source_view: config.source_view,
      source_card: config.source_card != null
        ? (typeof config.source_card === 'string' ? parseInt(config.source_card, 10) : config.source_card)
        : null,
      source_section: config.source_section != null
        ? (typeof config.source_section === 'string' ? parseInt(config.source_section, 10) : config.source_section)
        : null,
      layout,
    };
    this._resolvedConfig = null;
    this._cardEl = null;
    this._nativeEls = null;
  }

  updated(changedProps) {
    if (changedProps.has('hass') || changedProps.has('_config')) {
      // Propagate hass to child elements
      if (this._cardEl) {
        this._cardEl.hass = this.hass;
      }
      if (this._nativeEls) {
        for (const el of this._nativeEls) {
          el.hass = this.hass;
        }
      }
      const lc = _getLovelaceConfig();
      if (lc && lc !== this._lastLovelaceConfig) {
        this._lastLovelaceConfig = lc;
        this._resolvedConfig = null;
        this._cardEl = null;
        this._nativeEls = null;
        this.requestUpdate();
      }
    }
  }

  getCardSize() {
    if (this._cardEl && typeof this._cardEl.getCardSize === 'function') {
      return this._cardEl.getCardSize();
    }
    return this._config?.source_card == null ? 6 : 3;
  }

  getGridOptions() {
    if (this._cardEl && typeof this._cardEl.getGridOptions === 'function') {
      return this._cardEl.getGridOptions();
    }
    return { rows: 'auto', columns: 12, min_rows: 1 };
  }

  render() {
    if (!this._config) return html``;

    const lovelaceConfig = _getLovelaceConfig();
    if (!lovelaceConfig) return html``;
    this._lastLovelaceConfig = lovelaceConfig;

    const source = _resolveSource(
      lovelaceConfig,
      this._config.source_view,
      this._config.source_section,
      this._config.source_card,
    );

    if (!source) {
      return html`
        <ha-card>
          <div style="padding:16px;color:var(--error-color);">
            Mirror Card: ${t(this.hass, 'Source not found')}
            (view: ${this._config.source_view}${this._config.source_section != null ? `, section: ${this._config.source_section}` : ''}${this._config.source_card != null ? `, card: ${this._config.source_card}` : ''})
          </div>
        </ha-card>`;
    }

    // Filter out mirror-cards to prevent recursion (for card arrays)
    const filteredCards = source.cards.filter(c => c.type !== 'custom:mirror-card');
    if (filteredCards.length === 0) {
      return html`
        <ha-card>
          <div style="padding:16px;color:var(--error-color);">
            Mirror Card: ${t(this.hass, 'All source cards are mirror-cards (recursion prevention)')}
          </div>
        </ha-card>`;
    }

    const layout = this._config.layout;

    // ── Native layout rendering ─────────────────────────────────────
    if (layout === 'native' && source.mode !== 'card') {
      const lovelace = _getLovelaceObject();
      if (lovelace) {
        return this._renderNative(source, lovelace);
      }
      // Fallback to stack if lovelace object unavailable
    }

    // ── Card-based rendering (single card, stack, or grid) ──────────
    let effectiveConfig;
    if (filteredCards.length === 1) {
      effectiveConfig = filteredCards[0];
    } else if (layout === 'grid') {
      effectiveConfig = { type: 'grid', cards: filteredCards };
    } else {
      effectiveConfig = { type: 'vertical-stack', cards: filteredCards };
    }

    const configJSON = JSON.stringify(effectiveConfig);
    if (configJSON !== this._resolvedConfig) {
      this._resolvedConfig = configJSON;
      this._nativeEls = null;
      this._cardEl = _buildCardElement(effectiveConfig, this.hass);

      const tag = effectiveConfig.type?.startsWith('custom:')
        ? effectiveConfig.type.slice(7)
        : `hui-${effectiveConfig.type}-card`;
      if (!customElements.get(tag) && !customElements.get('hui-card')) {
        customElements.whenDefined(tag).then(() => {
          this._resolvedConfig = null;
          this.requestUpdate();
        });
      }
    }

    return html`${this._cardEl ?? ''}`;
  }

  _renderNative(source, lovelace) {
    const configJSON = JSON.stringify(
      source.mode === 'section' ? source.sectionConfig : source.viewConfig
    );
    if (configJSON !== this._resolvedConfig) {
      this._resolvedConfig = configJSON;
      this._cardEl = null;
      this._nativeEls = [];

      if (source.mode === 'section') {
        // Filter mirror-cards from section config
        const filteredConfig = {
          ...source.sectionConfig,
          cards: (source.sectionConfig.cards ?? []).filter(c => c.type !== 'custom:mirror-card'),
        };
        const el = _buildSectionElement(
          filteredConfig, this.hass, lovelace, source.viewIndex, source.sectionIndex
        );
        if (el) this._nativeEls.push(el);

      } else if (source.mode === 'view') {
        // Render each section from the view
        const sections = source.viewConfig.sections ?? [];
        sections.forEach((sec, si) => {
          // Filter mirror-cards from each section
          const filteredConfig = {
            ...sec,
            cards: (sec.cards ?? []).filter(c => c.type !== 'custom:mirror-card'),
          };
          if (filteredConfig.cards.length === 0) return;
          const el = _buildSectionElement(
            filteredConfig, this.hass, lovelace, source.viewIndex, si
          );
          if (el) this._nativeEls.push(el);
        });
      }
    }

    if (!this._nativeEls || this._nativeEls.length === 0) {
      return html`
        <ha-card>
          <div style="padding:16px;color:var(--error-color);">
            Mirror Card: ${t(this.hass, 'No renderable content found in source.')}
          </div>
        </ha-card>`;
    }

    return html`${this._nativeEls.map(el => html`${el}`)}`;
  }
}

// ── Mirror Card Editor ──────────────────────────────────────────────
class MirrorCardEditor extends LitElement {
  static get properties() {
    return {
      hass: { attribute: false },
      _config: { state: true },
    };
  }

  static get styles() {
    return css`
      .info {
        padding: 12px;
        background: var(--primary-color);
        color: var(--text-primary-color, #fff);
        border-radius: 8px;
        font-size: 13px;
        opacity: 0.85;
        margin-bottom: 16px;
      }
    `;
  }

  setConfig(config) {
    this._config = { ...config };
  }

  _getViews() {
    const lc = _getLovelaceConfig();
    if (!lc?.views) return [];
    return lc.views.map((v, i) => ({
      index: i,
      label: v.title || v.path || `View ${i}`,
      path: v.path || null,
      view: v,
    }));
  }

  _getSectionsForView(viewInfo) {
    if (!viewInfo) return [];
    const view = viewInfo.view;
    return (view.sections ?? []).map((sec, si) => ({
      index: si,
      label: sec.title || `Section ${si}`,
      section: sec,
    }));
  }

  _getCardsForSection(viewInfo, sectionIndex) {
    if (!viewInfo) return [];
    const section = (viewInfo.view.sections ?? [])[sectionIndex];
    if (!section) return [];
    return (section.cards ?? []).map((c, ci) => ({
      cardIndex: ci,
      label: _cardLabel(c, ci),
      config: c,
    }));
  }

  _getCardsForView(viewInfo) {
    if (!viewInfo) return [];
    const view = viewInfo.view;
    const cards = [];

    // Classic cards (top-level, no section)
    (view.cards ?? []).forEach((c, ci) => {
      cards.push({
        cardIndex: ci,
        section: null,
        label: _cardLabel(c, ci),
        config: c,
      });
    });

    // Section-based cards
    (view.sections ?? []).forEach((sec, si) => {
      (sec.cards ?? []).forEach((c, ci) => {
        cards.push({
          cardIndex: ci,
          section: si,
          label: `[Section ${si}] ${_cardLabel(c, ci)}`,
          config: c,
        });
      });
    });

    return cards;
  }

  _buildSchema() {
    const views = this._getViews();
    const viewOptions = views.map(v => ({
      value: String(v.index),
      label: `${v.label} (Index: ${v.index})`,
    }));

    const schema = [
      {
        name: 'source_view',
        label: t(this.hass, 'Source View'),
        selector: { select: { options: viewOptions, mode: 'dropdown' } },
      },
    ];

    // Determine current view
    const currentViewIndex = typeof this._config?.source_view === 'number'
      ? this._config.source_view
      : views.findIndex(v => v.path === this._config?.source_view || v.label === this._config?.source_view);
    const currentView = views[currentViewIndex] ?? null;

    const sections = this._getSectionsForView(currentView);
    const hasSections = sections.length > 0;

    if (hasSections) {
      // Section dropdown with "all" option
      const sectionOptions = [
        { value: 'all', label: t(this.hass, 'Mirror completely (all sections)') },
        ...sections.map(s => ({
          value: String(s.index),
          label: t(this.hass, 'Section: {label}', { label: s.label }),
        })),
      ];
      schema.push({
        name: 'source_section_key',
        label: t(this.hass, 'Source Section'),
        selector: { select: { options: sectionOptions, mode: 'dropdown' } },
      });

      // Card dropdown: only when a specific section is selected
      const sectionVal = this._config?.source_section;
      if (sectionVal != null) {
        const cards = this._getCardsForSection(currentView, sectionVal);
        const cardOptions = [
          { value: 'all', label: t(this.hass, 'All cards of this section') },
          ...cards.map(c => ({
            value: String(c.cardIndex),
            label: c.label,
          })),
        ];
        schema.push({
          name: 'source_card_key',
          label: t(this.hass, 'Source Card'),
          selector: { select: { options: cardOptions, mode: 'dropdown' } },
        });
      }
    } else {
      // Classic view (no sections): show flat card list with "all" option
      const cards = this._getCardsForView(currentView);
      if (cards.length > 0) {
        const cardOptions = [
          { value: 'all', label: t(this.hass, 'All cards of this view') },
          ...cards.map(c => ({
            value: c.section != null ? `${c.section}:${c.cardIndex}` : `null:${c.cardIndex}`,
            label: c.label,
          })),
        ];
        schema.push({
          name: 'source_card_key',
          label: t(this.hass, 'Source Card'),
          selector: { select: { options: cardOptions, mode: 'dropdown' } },
        });
      }
    }

    // Layout dropdown: shown when multi-card mirroring is active
    const isMultiCard = this._isMultiCard();
    if (isMultiCard) {
      schema.push({
        name: 'layout',
        label: t(this.hass, 'Layout'),
        selector: {
          select: {
            options: [
              { value: 'native', label: t(this.hass, 'Original Layout (1:1)') },
              { value: 'stack', label: t(this.hass, 'Vertical (Stack)') },
              { value: 'grid', label: t(this.hass, 'Grid') },
            ],
            mode: 'dropdown',
          },
        },
      });
    }

    return schema;
  }

  _isMultiCard() {
    if (this._config?.source_card == null) return true;
    return false;
  }

  _formData() {
    const viewVal = this._config?.source_view != null ? String(this._config.source_view) : '';
    const sectionVal = this._config?.source_section != null ? String(this._config.source_section) : 'all';

    // Card value depends on whether view has sections
    let cardVal = 'all';
    if (this._config?.source_card != null) {
      const views = this._getViews();
      const currentViewIndex = typeof this._config?.source_view === 'number'
        ? this._config.source_view
        : views.findIndex(v => v.path === this._config?.source_view);
      const currentView = views[currentViewIndex] ?? null;
      const hasSections = this._getSectionsForView(currentView).length > 0;

      if (hasSections) {
        cardVal = String(this._config.source_card);
      } else {
        const sec = this._config.source_section;
        cardVal = `${sec}:${this._config.source_card}`;
      }
    }

    const layout = this._config?.layout || 'native';
    return { source_view: viewVal, source_section_key: sectionVal, source_card_key: cardVal, layout };
  }

  _handleValueChanged(e) {
    e.stopPropagation();
    const val = e.detail.value;
    const prev = this._formData();

    // View changed -> reset section and card
    if (val.source_view !== prev.source_view) {
      this._config = {
        ...this._config,
        source_view: parseInt(val.source_view, 10),
        source_section: null,
        source_card: null,
      };
      this._fireChanged();
      return;
    }

    // Section changed -> reset card
    if (val.source_section_key !== undefined && val.source_section_key !== prev.source_section_key) {
      const section = val.source_section_key === 'all' ? null : parseInt(val.source_section_key, 10);
      this._config = {
        ...this._config,
        source_section: section,
        source_card: null,
      };
      this._fireChanged();
      return;
    }

    // Card changed
    if (val.source_card_key !== undefined && val.source_card_key !== prev.source_card_key) {
      if (val.source_card_key === 'all') {
        this._config = { ...this._config, source_card: null };
      } else {
        const parts = val.source_card_key.split(':');
        if (parts.length === 2) {
          const sec = parts[0] === 'null' ? null : parseInt(parts[0], 10);
          const ci = parseInt(parts[1], 10);
          this._config = { ...this._config, source_section: sec, source_card: ci };
        } else {
          this._config = { ...this._config, source_card: parseInt(val.source_card_key, 10) };
        }
      }
      this._fireChanged();
      return;
    }

    // Layout changed
    if (val.layout !== undefined && val.layout !== prev.layout) {
      this._config = { ...this._config, layout: val.layout };
      this._fireChanged();
    }
  }

  _fireChanged() {
    this.dispatchEvent(new CustomEvent('config-changed', {
      detail: { config: { ...this._config } },
      bubbles: true,
      composed: true,
    }));
  }

  render() {
    return html`
      <div class="info">
        ${t(this.hass, 'This card mirrors cards from another view, a section, or a single card.')}
      </div>
      <ha-form
        .hass=${this.hass}
        .schema=${this._buildSchema()}
        .data=${this._formData()}
        .computeLabel=${(s) => s.label}
        @value-changed=${this._handleValueChanged}
      ></ha-form>
    `;
  }
}

// ── Registration ────────────────────────────────────────────────────
customElements.define('mirror-card', MirrorCard);
customElements.define('mirror-card-editor', MirrorCardEditor);

window.customCards = window.customCards || [];
if (!window.customCards.find(c => c.type === 'mirror-card')) {
  window.customCards.push({
    type:        'mirror-card',
    name:        'Mirror Card',
    description: 'Mirrors cards from another view, a section, or a single card.',
    preview:     false,
  });
}

console.info(`%c MIRROR-CARD %c v${MIRROR_CARD_VERSION} `, 'background:#4CAF50;color:#fff;font-weight:bold;', 'background:#ddd;color:#333;');
