/**
 * ============================================================
 * LedgerSystem — Phase 1: Local Storage Data Architecture
 * Multi-Wallet Closed-Loop Ledger Utility
 * ============================================================
 * Schema (simulated relational structure inside localStorage):
 *
 * businesses:   { id, name, createdAt, plan }
 * categories:   { id, businessId, name, type ('integer'|'decimal'), active }
 * cards:        { id, businessId, barcode, customerName, customerMeta, active, createdAt }
 * wallets:      { id, cardId, categoryId, balance, updatedAt }
 * auditLogs:    { id, type ('transaction'|'account'), businessId, walletId, cardId, categoryId,
 *                 delta, balanceAfter, reason, employee, timestamp,
 *                 -- account-type entries additionally carry --
 *                 businessName, cardBarcode, categoryName, action, details }
 * ============================================================
 */

const LedgerSystem = (() => {

  const STORAGE_KEY = 'ledgerSystem_db_v1';

  const SCHEMA_VERSION = 1;

  // ---------- Internal Utilities ----------

  function _generateId(prefix = 'id') {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  function _now() {
    return new Date().toISOString();
  }

  function _loadDB() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return _initDB();
    }
    try {
      return JSON.parse(raw);
    } catch (e) {
      console.error('LedgerSystem: corrupted DB, reinitializing.', e);
      return _initDB();
    }
  }

  function _saveDB(db) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  }

  function _initDB() {
    const db = {
      schemaVersion: SCHEMA_VERSION,
      businesses: [],
      categories: [],
      cards: [],
      wallets: [],
      auditLogs: []
    };
    _saveDB(db);
    return db;
  }

  // ---------- Validation Helpers ----------

  function _validateAmount(value, type) {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      throw new Error('Amount must be a valid number.');
    }
    if (type === 'integer' && !Number.isInteger(value)) {
      throw new Error('This category requires integer values.');
    }
  }

  /**
   * Writes an "account"-type audit log entry: creations, edits, and
   * deletions of businesses, categories, and cards, as opposed to
   * "transaction"-type entries (balance adjustments). Account-type
   * entries carry denormalized snapshot fields (businessName,
   * cardBarcode, categoryName) so they remain meaningful even after
   * the entity they describe has since been deleted or renamed.
   */
  function _addAccountLog(db, {
    businessId,
    businessName = null,
    cardId = null,
    cardBarcode = null,
    categoryId = null,
    categoryName = null,
    action,
    details,
    employee = 'admin'
  }) {
    const logEntry = {
      id: _generateId('log'),
      type: 'account',
      businessId,
      businessName,
      walletId: null,
      cardId,
      cardBarcode,
      categoryId,
      categoryName,
      delta: null,
      balanceAfter: null,
      action,
      reason: details,
      details,
      employee,
      timestamp: _now(),
      reverted: false,
      revertedByLogId: null,
      reversalOfLogId: null
    };
    db.auditLogs.push(logEntry);
    return logEntry;
  }

  // ============================================================
  // BUSINESS FUNCTIONS
  // ============================================================

  function createBusiness({ name, plan = 'free' }, employee = 'admin') {
    const db = _loadDB();
    const business = {
      id: _generateId('biz'),
      name,
      plan,
      createdAt: _now()
    };
    db.businesses.push(business);

    _addAccountLog(db, {
      businessId: business.id,
      businessName: business.name,
      action: 'business_created',
      details: `Business "${business.name}" created`,
      employee
    });

    _saveDB(db);
    return business;
  }

  function getBusiness(businessId) {
    const db = _loadDB();
    return db.businesses.find(b => b.id === businessId) || null;
  }

  function listBusinesses() {
    return _loadDB().businesses;
  }

  /**
   * Renames a business account.
   */
  function updateBusiness(businessId, { name } = {}, employee = 'admin') {
    const db = _loadDB();
    const business = db.businesses.find(b => b.id === businessId);
    if (!business) throw new Error('Business not found.');
    if (name !== undefined && name.trim() && name.trim() !== business.name) {
      const oldName = business.name;
      business.name = name.trim();
      _addAccountLog(db, {
        businessId: business.id,
        businessName: business.name,
        action: 'business_renamed',
        details: `Business renamed from "${oldName}" to "${business.name}"`,
        employee
      });
    }
    _saveDB(db);
    return business;
  }

  /**
   * Permanently deletes a business and cascades removal of every
   * related record: its categories, cards, wallets, and transaction
   * logs. Account-type audit entries (creations/edits/deletions) are
   * preserved even after the business is gone, so the deletion event
   * itself remains part of the historical record.
   */
  function deleteBusiness(businessId, employee = 'admin') {
    const db = _loadDB();

    const business = db.businesses.find(b => b.id === businessId);
    if (!business) throw new Error('Business not found.');

    _addAccountLog(db, {
      businessId: business.id,
      businessName: business.name,
      action: 'business_deleted',
      details: `Business "${business.name}" deleted`,
      employee
    });

    const cardIds = new Set(
      db.cards.filter(c => c.businessId === businessId).map(c => c.id)
    );

    db.businesses = db.businesses.filter(b => b.id !== businessId);
    db.categories = db.categories.filter(c => c.businessId !== businessId);
    db.cards = db.cards.filter(c => c.businessId !== businessId);
    db.wallets = db.wallets.filter(w => !cardIds.has(w.cardId));
    db.auditLogs = db.auditLogs.filter(l => l.type === 'account' || !cardIds.has(l.cardId));

    _saveDB(db);
    return { deletedBusinessId: businessId };
  }

  // ============================================================
  // CATEGORY FUNCTIONS
  // ============================================================

  function createCategory({ businessId, name, type = 'integer' }, employee = 'admin') {
    if (!['integer', 'decimal', 'string'].includes(type)) {
      throw new Error('Category type must be "integer", "decimal", or "string".');
    }
    const db = _loadDB();
    if (!db.businesses.find(b => b.id === businessId)) {
      throw new Error(`Business ${businessId} does not exist.`);
    }

    const normalizedName = (name || '').trim().toLowerCase();
    const duplicate = db.categories.some(
      c => c.businessId === businessId &&
           c.active &&
           c.name.trim().toLowerCase() === normalizedName
    );
    if (duplicate) {
      throw new Error(`A category named "${name}" already exists for this business.`);
    }

    const maxOrder = db.categories
      .filter(c => c.businessId === businessId)
      .reduce((max, c) => Math.max(max, c.order ?? 0), 0);

    const category = {
      id: _generateId('cat'),
      businessId,
      name,
      type,
      active: true,
      order: maxOrder + 1,
      createdAt: _now()
    };
    db.categories.push(category);

    const business = db.businesses.find(b => b.id === businessId);
    _addAccountLog(db, {
      businessId,
      businessName: business ? business.name : 'Unknown business',
      categoryId: category.id,
      categoryName: category.name,
      action: 'category_created',
      details: `Category "${category.name}" created (${type})`,
      employee
    });

    _saveDB(db);
    return category;
  }

  function listCategoriesForBusiness(businessId, activeOnly = true) {
    const db = _loadDB();
    return db.categories
      .filter(c => c.businessId === businessId && (!activeOnly || c.active))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  /**
   * Reorders categories for a business. `orderedCategoryIds` is the full
   * list of category IDs for that business in the desired display order;
   * each category's `order` field is rewritten to match its new position.
   */
  function reorderCategories(businessId, orderedCategoryIds) {
    const db = _loadDB();

    orderedCategoryIds.forEach((catId, index) => {
      const cat = db.categories.find(c => c.id === catId && c.businessId === businessId);
      if (cat) {
        cat.order = index + 1;
      }
    });

    _saveDB(db);
    return listCategoriesForBusiness(businessId, true);
  }

  /**
   * Renames an existing category, respecting the same case-insensitive
   * duplicate-name rule used at creation time.
   */
  function updateCategory(categoryId, { name } = {}, employee = 'admin') {
    const db = _loadDB();
    const category = db.categories.find(c => c.id === categoryId);
    if (!category) throw new Error('Category not found.');

    if (name !== undefined && name.trim()) {
      const normalizedName = name.trim().toLowerCase();
      const duplicate = db.categories.some(
        c => c.id !== categoryId &&
             c.businessId === category.businessId &&
             c.active &&
             c.name.trim().toLowerCase() === normalizedName
      );
      if (duplicate) {
        throw new Error(`A category named "${name}" already exists for this business.`);
      }
      const oldName = category.name;
      category.name = name.trim();

      if (oldName !== category.name) {
        const business = db.businesses.find(b => b.id === category.businessId);
        _addAccountLog(db, {
          businessId: category.businessId,
          businessName: business ? business.name : 'Unknown business',
          categoryId: category.id,
          categoryName: category.name,
          action: 'category_renamed',
          details: `Category renamed from "${oldName}" to "${category.name}"`,
          employee
        });
      }
    }

    _saveDB(db);
    return category;
  }

  function deactivateCategory(categoryId, employee = 'admin') {
    const db = _loadDB();
    const cat = db.categories.find(c => c.id === categoryId);
    if (!cat) throw new Error('Category not found.');
    cat.active = false;

    const business = db.businesses.find(b => b.id === cat.businessId);
    _addAccountLog(db, {
      businessId: cat.businessId,
      businessName: business ? business.name : 'Unknown business',
      categoryId: cat.id,
      categoryName: cat.name,
      action: 'category_deactivated',
      details: `Category "${cat.name}" deactivated`,
      employee
    });

    _saveDB(db);
    return cat;
  }

  // ============================================================
  // CARD FUNCTIONS
  // ============================================================

  function createCard({ businessId, barcode, customerName = '', customerMeta = {} }, employee = 'admin') {
    const db = _loadDB();

    if (!db.businesses.find(b => b.id === businessId)) {
      throw new Error(`Business ${businessId} does not exist.`);
    }

    const barcodeExists = db.cards.some(
      c => c.barcode === barcode && c.businessId === businessId
    );
    if (barcodeExists) {
      throw new Error(`Barcode "${barcode}" already exists for this business.`);
    }

    const card = {
      id: _generateId('card'),
      businessId,
      barcode,
      customerName,
      customerMeta,
      active: true,
      createdAt: _now()
    };
    db.cards.push(card);

    const business = db.businesses.find(b => b.id === businessId);
    _addAccountLog(db, {
      businessId,
      businessName: business ? business.name : 'Unknown business',
      cardId: card.id,
      cardBarcode: card.barcode,
      action: 'card_created',
      details: `Card provisioned: ${barcode}${customerName ? ` (${customerName})` : ''}`,
      employee
    });

    _saveDB(db);
    return card;
  }

  function findCardByBarcode(barcode, businessId = null) {
    const db = _loadDB();
    return db.cards.find(c =>
      c.barcode === barcode &&
      (businessId === null || c.businessId === businessId)
    ) || null;
  }

  function deactivateCard(cardId, employee = 'admin') {
    const db = _loadDB();
    const card = db.cards.find(c => c.id === cardId);
    if (!card) throw new Error('Card not found.');
    card.active = false;

    const business = db.businesses.find(b => b.id === card.businessId);
    _addAccountLog(db, {
      businessId: card.businessId,
      businessName: business ? business.name : 'Unknown business',
      cardId: card.id,
      cardBarcode: card.barcode,
      action: 'card_deactivated',
      details: `Card deactivated: ${card.barcode}`,
      employee
    });

    _saveDB(db);
    return card;
  }

  /**
   * Updates editable fields on a card: barcode, name, and/or
   * customerMeta (e.g. notes). Barcode changes are validated against
   * the same per-business uniqueness rule enforced at creation time.
   * Every field that actually changes is written to the audit log as
   * a single "card_updated" entry.
   */
  function updateCard(cardId, { barcode, customerName, customerMeta } = {}, employee = 'admin') {
    const db = _loadDB();
    const card = db.cards.find(c => c.id === cardId);
    if (!card) throw new Error('Card not found.');

    const changes = [];

    if (barcode !== undefined) {
      const trimmed = barcode.trim();
      if (!trimmed) throw new Error('Barcode cannot be empty.');
      if (trimmed !== card.barcode) {
        const barcodeTaken = db.cards.some(
          c => c.id !== cardId && c.barcode === trimmed && c.businessId === card.businessId
        );
        if (barcodeTaken) {
          throw new Error(`Barcode "${trimmed}" already exists for this business.`);
        }
        changes.push(`barcode changed from "${card.barcode}" to "${trimmed}"`);
        card.barcode = trimmed;
      }
    }

    if (customerName !== undefined && customerName !== card.customerName) {
      changes.push(`name changed from "${card.customerName || '(none)'}" to "${customerName || '(none)'}"`);
      card.customerName = customerName;
    }

    if (customerMeta !== undefined) {
      const oldNotes = (card.customerMeta && card.customerMeta.notes) || '';
      const newNotes = (customerMeta && customerMeta.notes) || '';
      if (oldNotes !== newNotes) {
        changes.push('notes updated');
      }
      card.customerMeta = customerMeta;
    }

    if (changes.length) {
      const business = db.businesses.find(b => b.id === card.businessId);
      _addAccountLog(db, {
        businessId: card.businessId,
        businessName: business ? business.name : 'Unknown business',
        cardId: card.id,
        cardBarcode: card.barcode,
        action: 'card_updated',
        details: `Card updated — ${changes.join('; ')}`,
        employee
      });
    }

    _saveDB(db);
    return card;
  }

  /**
   * Permanently deletes a card/customer and cascades removal of its
   * wallets and transaction logs. Account-type audit entries (including
   * this deletion event) are preserved for the historical record even
   * though the card itself is gone.
   */
  function deleteCard(cardId, employee = 'admin') {
    const db = _loadDB();

    const card = db.cards.find(c => c.id === cardId);
    if (!card) throw new Error('Card not found.');

    const business = db.businesses.find(b => b.id === card.businessId);
    _addAccountLog(db, {
      businessId: card.businessId,
      businessName: business ? business.name : 'Unknown business',
      cardId: card.id,
      cardBarcode: card.barcode,
      action: 'card_deleted',
      details: `Card deleted: ${card.barcode}${card.customerName ? ` (${card.customerName})` : ''}`,
      employee
    });

    db.cards = db.cards.filter(c => c.id !== cardId);
    db.wallets = db.wallets.filter(w => w.cardId !== cardId);
    db.auditLogs = db.auditLogs.filter(l => !(l.cardId === cardId && l.type !== 'account'));

    _saveDB(db);
    return { deletedCardId: cardId };
  }

  // ============================================================
  // WALLET FUNCTIONS
  // ============================================================

  function _getOrCreateWallet(db, cardId, categoryId, categoryType = 'integer') {
    let wallet = db.wallets.find(
      w => w.cardId === cardId && w.categoryId === categoryId
    );
    if (!wallet) {
      wallet = {
        id: _generateId('wal'),
        cardId,
        categoryId,
        balance: categoryType === 'string' ? '' : 0,
        updatedAt: _now()
      };
      db.wallets.push(wallet);
    }
    return wallet;
  }

  function getWalletsForCard(cardId) {
    const db = _loadDB();
    const card = db.cards.find(c => c.id === cardId);
    if (!card) throw new Error('Card not found.');

    const categories = db.categories
      .filter(cat => cat.businessId === card.businessId && cat.active)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    return categories.map(cat => {
      const wallet = db.wallets.find(
        w => w.cardId === cardId && w.categoryId === cat.id
      );
      return {
        categoryId: cat.id,
        categoryName: cat.name,
        type: cat.type,
        balance: wallet ? wallet.balance : 0,
        walletId: wallet ? wallet.id : null
      };
    });
  }

  // ============================================================
  // TRANSACTION FUNCTIONS (add/subtract with audit logging)
  // ============================================================

  /**
   * Adjusts a wallet balance by `delta` (positive to add, negative to subtract).
   * Always writes an audit log entry on success.
   */
  function adjustBalance({ cardId, categoryId, delta, reason = '', employee = 'unknown' }) {
    const db = _loadDB();

    const card = db.cards.find(c => c.id === cardId);
    if (!card) throw new Error('Card not found.');
    if (!card.active) throw new Error('Card is inactive.');

    const category = db.categories.find(c => c.id === categoryId);
    if (!category) throw new Error('Category not found.');
    if (!category.active) throw new Error('Category is inactive.');
    if (category.businessId !== card.businessId) {
      throw new Error('Category does not belong to the same business as the card.');
    }
    if (category.type === 'string') {
      throw new Error('This category holds a text value; use setTextValue() instead of add/subtract.');
    }

    _validateAmount(delta, category.type);

    const wallet = _getOrCreateWallet(db, cardId, categoryId, category.type);

    const newBalance = wallet.balance + delta;
    if (newBalance < 0) {
      throw new Error(
        `Insufficient balance. Current: ${wallet.balance}, attempted delta: ${delta}.`
      );
    }

    wallet.balance = newBalance;
    wallet.updatedAt = _now();

    const logEntry = {
      id: _generateId('log'),
      type: 'transaction',
      businessId: card.businessId,
      walletId: wallet.id,
      cardId,
      categoryId,
      delta,
      balanceAfter: newBalance,
      reason,
      employee,
      timestamp: _now(),
      reverted: false,
      revertedByLogId: null,
      reversalOfLogId: null
    };
    db.auditLogs.push(logEntry);

    _saveDB(db);

    return { wallet, logEntry };
  }

  /**
   * Reverses a previously-logged transaction by applying the inverse delta.
   * The original log entry is flagged `reverted: true` (never deleted, so the
   * ledger stays a complete historical record). A brand new audit log entry
   * is written for the reversal itself, referencing the original via
   * `reversalOfLogId`, so the balance sheet always reflects real events.
   */
  function revertLog(logId, employee = 'unknown') {
    const db = _loadDB();

    const originalLog = db.auditLogs.find(l => l.id === logId);
    if (!originalLog) throw new Error('Audit log entry not found.');
    if (originalLog.reverted) throw new Error('This log entry has already been reverted.');

    const card = db.cards.find(c => c.id === originalLog.cardId);
    if (!card) throw new Error('Card associated with this log no longer exists.');

    const category = db.categories.find(c => c.id === originalLog.categoryId);
    if (!category) throw new Error('Category associated with this log no longer exists.');

    const wallet = db.wallets.find(
      w => w.cardId === originalLog.cardId && w.categoryId === originalLog.categoryId
    );
    if (!wallet) throw new Error('Wallet associated with this log no longer exists.');

    const inverseDelta = -originalLog.delta;
    const newBalance = wallet.balance + inverseDelta;

    if (newBalance < 0) {
      throw new Error(
        `Cannot revert: resulting balance would be negative (${newBalance}).`
      );
    }

    wallet.balance = newBalance;
    wallet.updatedAt = _now();

    const reversalLog = {
      id: _generateId('log'),
      type: 'transaction',
      businessId: card.businessId,
      walletId: wallet.id,
      cardId: originalLog.cardId,
      categoryId: originalLog.categoryId,
      delta: inverseDelta,
      balanceAfter: newBalance,
      reason: `Reversal of log ${originalLog.id} (${originalLog.reason || 'no reason given'})`,
      employee,
      timestamp: _now(),
      reverted: false,
      revertedByLogId: null,
      reversalOfLogId: originalLog.id
    };
    db.auditLogs.push(reversalLog);

    originalLog.reverted = true;
    originalLog.revertedByLogId = reversalLog.id;

    _saveDB(db);

    return { wallet, originalLog, reversalLog };
  }

  /**
   * Sets the text value for a "string"-type category (e.g. "Membership Tier",
   * "Notes"). String categories don't support add/subtract deltas, so this
   * directly overwrites the wallet's value and still writes an audit log
   * entry (delta is null; the log records old/new text in `reason`).
   */
  function setTextValue({ cardId, categoryId, value, reason = '', employee = 'unknown' }) {
    const db = _loadDB();

    const card = db.cards.find(c => c.id === cardId);
    if (!card) throw new Error('Card not found.');
    if (!card.active) throw new Error('Card is inactive.');

    const category = db.categories.find(c => c.id === categoryId);
    if (!category) throw new Error('Category not found.');
    if (!category.active) throw new Error('Category is inactive.');
    if (category.type !== 'string') {
      throw new Error('setTextValue() can only be used on "string"-type categories.');
    }
    if (category.businessId !== card.businessId) {
      throw new Error('Category does not belong to the same business as the card.');
    }

    const wallet = _getOrCreateWallet(db, cardId, categoryId, 'string');
    const oldValue = wallet.balance;

    wallet.balance = String(value);
    wallet.updatedAt = _now();

    const logEntry = {
      id: _generateId('log'),
      type: 'transaction',
      businessId: card.businessId,
      walletId: wallet.id,
      cardId,
      categoryId,
      delta: null,
      balanceAfter: wallet.balance,
      reason: reason || `Set from "${oldValue}" to "${wallet.balance}"`,
      employee,
      timestamp: _now(),
      reverted: false,
      revertedByLogId: null,
      reversalOfLogId: null
    };
    db.auditLogs.push(logEntry);

    _saveDB(db);

    return { wallet, logEntry };
  }

  function addValue({ cardId, categoryId, amount, reason = 'manual add', employee }) {
    if (amount < 0) throw new Error('Use a positive amount for addValue().');
    return adjustBalance({ cardId, categoryId, delta: amount, reason, employee });
  }

  function subtractValue({ cardId, categoryId, amount, reason = 'manual subtract', employee }) {
    if (amount < 0) throw new Error('Use a positive amount for subtractValue().');
    return adjustBalance({ cardId, categoryId, delta: -amount, reason, employee });
  }

  // ============================================================
  // AUDIT LOG QUERIES
  // ============================================================

  function getLogsForCard(cardId) {
    const db = _loadDB();
    return db.auditLogs
      .filter(log => log.cardId === cardId)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  }

  function getLogsForWallet(walletId) {
    const db = _loadDB();
    return db.auditLogs
      .filter(log => log.walletId === walletId)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  }

  /**
   * Returns all audit logs belonging to a business (across all its cards,
   * plus account-level events like business/category/card creation, edits,
   * and deletions), newest first. Optionally limited to a single card's logs.
   */
  function getLogsForBusiness(businessId, { cardId = null, limit = null } = {}) {
    const db = _loadDB();
    const businessCardIds = new Set(
      db.cards.filter(c => c.businessId === businessId).map(c => c.id)
    );

    let logs = db.auditLogs.filter(log =>
      log.businessId === businessId ||
      (log.businessId === undefined && businessCardIds.has(log.cardId))
    );

    if (cardId) {
      logs = logs.filter(log => log.cardId === cardId);
    }

    logs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    if (limit) {
      logs = logs.slice(0, limit);
    }

    return logs;
  }

  // ============================================================
  // DEBUG / RESET UTILITIES
  // ============================================================

  function _resetAll() {
    return _initDB();
  }

  function _dumpDB() {
    return _loadDB();
  }

  // ---------- Public API ----------

  return {
    createBusiness,
    getBusiness,
    listBusinesses,
    updateBusiness,
    deleteBusiness,

    createCategory,
    listCategoriesForBusiness,
    updateCategory,
    reorderCategories,
    deactivateCategory,

    createCard,
    findCardByBarcode,
    updateCard,
    deactivateCard,
    deleteCard,

    getWalletsForCard,

    adjustBalance,
    addValue,
    subtractValue,
    setTextValue,
    revertLog,

    getLogsForCard,
    getLogsForWallet,
    getLogsForBusiness,

    _resetAll,
    _dumpDB
  };
})();
