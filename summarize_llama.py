from llama_cpp import Llama
from pathlib import Path


_llm = None
def _get_lmm(model_path = "models/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf"):
    global _llm
    if _llm is None:
        _llm = Llama(model_path=model_path, n_ctx=4096,n_threads=8)
    return _llm

def complete(raw_txt_path, out_path):
    llm = _get_lmm()
    transcript = Path(raw_txt_path).read_text(encoding="utf-8")
    
    
    messages = [
        {
            "role": "system",
            "content": "You are a meeting notes assistant. Reply ONLY in Markdown. If the information wasn't given, don't output it. Also if you believe the information that was given isnt relevant to any of the contents below just return the given transcript"
        },
        { 
            "role": "user",
            "content": f"""
        Transcript:
        \"\"\"{transcript}\"\"\"

        Output format (use exactly these sections, even if some are empty):
        # Title
        - One-liner purpose of meeting

        ## Key Points
        - bullet 1
        - bullet 2

        ## Decisions
        - decision 1

        ## Action Items
        - [Owner] task — due date (if mentioned)

        ## Open Questions
        - question

        ## Timeline / Dates Mentioned
        - item
        """}
    ]


    out = llm.create_chat_completion(
        messages= messages,
        max_tokens= 800,
        temperature= 0.3
    )
    final_transcript_txt = out["choices"][0]["message"]["content"].strip()
    # Path(out_path).write_text(final_transcript_txt, encoding="utf-8")
    return final_transcript_txt

