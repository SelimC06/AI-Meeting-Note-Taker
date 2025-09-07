import tkinter
from tkinter import ttk
from pathlib import Path
from PIL import Image, ImageTk
import record_and_transcribe
import summarize_llama
import threading

# Main Panel
root = tkinter.Tk()
root.title("Meeting Note Taker")
root.geometry("450x300")
root.configure(bg="#2b2b2b") 

transcript = Path(("transcripts/final_transcript_long.txt")).read_text(encoding="utf-8")

# Text Panel
panel = ttk.Frame(
    root,
    width=350, 
    height=280, 
    padding=8)
panel.place(x=10, y=10)
panel.grid_propagate(False)
panel.grid_rowconfigure(0, weight=1)
panel.grid_columnconfigure(0, weight=1)

text   = tkinter.Text(
    panel,
    wrap="word",
    font=("Consolas", 8),
    undo=True
)
scroll = ttk.Scrollbar(panel, orient="vertical")
text.grid(row=0, column=0, sticky="nsew")
scroll.grid(row=0, column=1, sticky="ns")
text.config(yscrollcommand=scroll.set)
scroll.config(command=text.yview)

def deletePanel():
    text.delete("1.0", tkinter.END)

# Buttons
play_button_image = ImageTk.PhotoImage(Image.open("image/play_button.png").resize((85,65), Image.LANCZOS))
pause_button_image = ImageTk.PhotoImage(Image.open("image/pause_image.png").resize((65,65), Image.LANCZOS))
reset_button_image = ImageTk.PhotoImage(Image.open("image/reset_image.png").resize((80, 80), Image.LANCZOS))

button_play = tkinter.Button(
    root, image=play_button_image,)
button_pause = tkinter.Button(
    root, image = pause_button_image)
button_reset = tkinter.Button(
    root, image=reset_button_image
)

button_play.place(x=375, y=10, width = 65, height = 65)
button_pause.place(x=375, y=80, width = 65, height = 65)
button_reset.place(x=375, y=150, width = 65, height = 65)

# Button Functions
running = False
worker  = None

def AI_worker(raw_txt_path):
    final_path = Path(("transcripts/final_transcript_long.txt")).read_text(encoding="utf-8")
    final_md = summarize_llama.complete(raw_txt_path, final_path)

    def update_ui():
        deletePanel()
        text.insert("end", final_md)
        button_play.config(state="normal", relief="raised")
        button_pause.config(state="normal", relief="raised")
    root.after(0, update_ui)

def _worker():
    raw_txt_path = record_and_transcribe.check(out_dir="transcript")
    def finish():
        global running
        button_pause.config(relief="sunken")
        button_play.config(relief="raised")
        running = False
        if raw_txt_path:
            threading.Thread(target=AI_worker, args=(raw_txt_path,),daemon=True).start()
    root.after(0, finish)
    
def press_play():
    global running
    if running:
        return
    running = True
    button_play.config(relief="sunken", state="disabled")
    button_pause.config(state="active", relief="raised")
    threading.Thread(target=_worker, daemon=True).start()

def press_pause():
    if not running:
        return
    button_pause.config(relief="sunken", state="disabled")
    button_play.config(relief="raised", state="active")
    record_and_transcribe.close()

def press_reset():
    if running:
        return
    button_pause.config(relief = "sunken", state = "disabled")
    button_play.config(relief = "raised", state = "active")
    deletePanel()

button_play.config(command=press_play)
button_pause.config(command=press_pause)
button_reset.config(command=press_reset)

text.insert("end", f"{transcript}")

root.mainloop()