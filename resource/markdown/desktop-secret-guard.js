(() => {
    const SETTINGS_KEY = 'vditor-global-settings';
    const secretByModel = new Map();
    const rawGetItem = Storage.prototype.getItem;
    const rawSetItem = Storage.prototype.setItem;

    const parseModels = (settings) => {
        const raw = settings?.aiModels;
        try {
            const models = typeof raw === 'string' ? JSON.parse(raw) : raw;
            return Array.isArray(models) ? models : [];
        } catch {
            return [];
        }
    };

    const identity = (model) => typeof model?.id === 'string' && model.id
        ? model.id
        : typeof model?.url === 'string' ? model.url : '';

    const protect = (serialized, rehydrate) => {
        if (!serialized) return serialized;
        try {
            const settings = JSON.parse(serialized);
            const models = parseModels(settings).map((model) => {
                const id = identity(model);
                if (typeof model?.key === 'string' && model.key) secretByModel.set(id, model.key);
                const { key: _key, ...safe } = model;
                return rehydrate && id && secretByModel.has(id)
                    ? { ...safe, key: secretByModel.get(id) }
                    : safe;
            });
            if (models.length) settings.aiModels = JSON.stringify(models);
            return JSON.stringify(settings);
        } catch {
            return serialized;
        }
    };

    try {
        const existing = rawGetItem.call(localStorage, SETTINGS_KEY);
        if (existing) rawSetItem.call(localStorage, SETTINGS_KEY, protect(existing, false));
    } catch {
        // Storage can be unavailable in hardened browser contexts.
    }

    Storage.prototype.setItem = function (key, value) {
        if (this === localStorage && key === SETTINGS_KEY) {
            return rawSetItem.call(this, key, protect(String(value), false));
        }
        return rawSetItem.call(this, key, value);
    };

    Storage.prototype.getItem = function (key) {
        const value = rawGetItem.call(this, key);
        if (this === localStorage && key === SETTINGS_KEY) return protect(value, true);
        return value;
    };
})();
