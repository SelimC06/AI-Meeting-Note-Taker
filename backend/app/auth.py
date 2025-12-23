import os, time, secrets, base64, hashlib
from typing import Dict
from urllib.parse import urlencode
import httpx
from fastapi import APIRouter, Request, Response, HTTPException
from fastapi.responses import RedirectResponse
from jose import jwt

router = APIRouter(prefix="/auth", tags=["auth"])

GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET", "")
GOOGLE_REDIRECT_URI = os.getenv("GOOGLE_REDIRECT_URI", "http://localhost:8000/auth/google/callback")
FRONTEND_ORIGIN = os.getenv("FRONTEND_ORIGIN", "http://localhost:5173")
AFTER_LOGIN_PATH = os.getenv("AFTER_LOGIN_PATH", "/")

def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()

def _pkce():
    verifier = _b64url(os.urandom(32))
    challenge = _b64url(hashlib.sha256(verifier.encode()).digest())
    return verifier, challenge

STATE: Dict[str, dict] = {}
SESSIONS: Dict[str, dict] = {}

@router.get("/google/login")
def google_login():
    if not GOOGLE_CLIENT_ID or not GOOGLE_CLIENT_SECRET:
        raise HTTPException(500, "OAuth not configured on server")
    state = _b64url(os.urandom(24))
    verifier, challenge = _pkce()
    STATE[state] = {"verifier": verifier, "ts": int(time.time())}

    params = {
        "client_id": GOOGLE_CLIENT_ID,
        "redirect_uri": GOOGLE_REDIRECT_URI,
        "response_type": "code",
        "scope": "openid email profile",
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "access_type": "offline",
        "prompt": "consent",
    }

    return {"redirect": f"https://accounts.google.com/o/oauth2/v2/auth?{urlencode(params)}"}

@router.get("/google/callback")
async def google_callback(response: Response, code: str, state: str):
    meta = STATE.pop(state, None)
    if not meta:
        raise HTTPException(400, "Invalid state")
    
    async with httpx.AsyncClient(timeout=15) as client:
        token_res = await client.post("https://oauth2.googleapis.com/token", data={
            "client_id": GOOGLE_CLIENT_ID,
            "client_secret": GOOGLE_CLIENT_SECRET,
            "code": code,
            "code_verifier": meta["verifier"],
            "grant_type": "authorization_code",
            "redirect_uri": GOOGLE_REDIRECT_URI,
        })
    if token_res.status_code != 200:
        raise HTTPException(400, f"Token exchange failed: {token_res.text}")
    
    id_token = token_res.json().get("id_token")
    if not id_token:
        raise HTTPException(400, "No id_token returned")
    
    claims = jwt.get_unverified_claims(id_token)
    if claims.get("aud") != GOOGLE_CLIENT_ID:
        raise HTTPException(400, "Bad audience")
    
    sid = _b64url(os.urandom(24))
    SESSIONS[sid] = {
        "sub": claims.get("sub"),
        "email": claims.get("email"),
        "name": claims.get("name"),
        "picture": claims.get("picture"),
        "exp": int(time.time()) + 86400,
    }

    resp = RedirectResponse(url=f"{FRONTEND_ORIGIN}{AFTER_LOGIN_PATH}", status_code=303)
    resp.set_cookie("session_id", sid, httponly=True, samesite="Lax", secure=False, path="/")
    return resp

@router.get("/me")
def me(request: Request):
    sid = request.cookies.get("session_id")
    s = SESSIONS.get(sid)
    if not s or s["exp"] < int(time.time()):
        return {"authenticated": False}
    return {"authenticated": True, "user": {k: s[k] for k in ("email", "name", "picture", "sub")}}

@router.post("/logout")
def logout(request: Request):
    sid = request.cookies.get("session_id")
    if sid in SESSIONS:
        del SESSIONS[sid]
    resp = Response(status_code=204)
    resp.delete_cookie("session_id", path="/")
    return resp
