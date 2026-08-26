UPDATE erp_users
SET role = 'sales',
    session_version = session_version + 1,
    version = version + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    updated_by = 'migration:0004_specialist_roles_to_sales'
WHERE role = 'specialist';
