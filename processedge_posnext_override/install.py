from processedge_posnext_override.overrides.pos_settings import ensure_posnext_settings_sync
from processedge_posnext_override.permissions import ensure_posnext_permission_compatibility
from processedge_posnext_override.eod_print_format_compat import ensure_eod_print_format_compat


def after_install():
    ensure_posnext_settings_sync()
    ensure_posnext_permission_compatibility()


def after_migrate():
    ensure_posnext_settings_sync()
    ensure_posnext_permission_compatibility()
    ensure_eod_print_format_compat()
