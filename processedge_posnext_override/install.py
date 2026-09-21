from processedge_posnext_override.overrides.pos_settings import ensure_posnext_settings_sync
from processedge_posnext_override.permissions import ensure_posnext_permission_compatibility


def after_install():
    ensure_posnext_settings_sync()
    ensure_posnext_permission_compatibility()


def after_migrate():
    ensure_posnext_settings_sync()
    ensure_posnext_permission_compatibility()
