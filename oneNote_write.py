import msal, requests, datetime, json

CLIENT_ID = 'a8eea917-c70c-48e0-81b2-f8718600f304'
AUTHORITY = 'https://login.microsoftonline.com/common'
SCOPES = ["Notes.ReadWrite"]

GRAPH = "https://graph.microsoft.com/v1.0"

def get_token():
    app = msal.PublicClientApplication(
        CLIENT_ID,
        authority = AUTHORITY,
        enable_broker_on_windows=True
    )
    result = app.acquire_token_silent(SCOPES,account=None)
    if not result:
        result = app.acquire_token_interactive(SCOPES,
                                               parent_window_handle=app.CONSOLE_WINDOW_HANDLE)
    if "access_token" not in result:
        print("System Failure")
    return result['access_token']

def create_page(message: str, title: str = "Page from Python", section_id: str | None = None, token : str | None = None):
    created_iso = datetime.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"
    html = f"""<!DOCTYPE HTML>
<html>
    <body>
        <p>{message}</p>
    </body>
</html>"""
    
    headers = {"Authorization" : 'Bearer ' + token,
               "Content-Type" : "application/xhtml+xml"}
    url = f"{GRAPH}/me/onenote/sections/{section_id}/pages"

    r = requests.post(url, headers=headers, data = html.encode("utf-8"))
    page = r.json()
    print("Created page")
    return page[id]

def find_section_id_by_name(section_name : str, token : str | None = None) -> str:
    r = requests.get(f"{GRAPH}/me/onenote/sections",
                     headers={'Authorization' : 'Bearer ' + token})
    r.raise_for_status()
    for s in r.json().get("value", []):
        if s.get('displayName', '').lower() == section_name.lower():
            return s['id']
    return None

token = get_token()
sec_id = find_section_id_by_name("TestingPython", token=token)
if sec_id:
    new_page_id = create_page(
        message="Hello from Python! This page was created via Microsoft Graph.",
        title="Test page created by script",
        section_id=sec_id,
        token=token
    )

