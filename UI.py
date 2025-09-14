import tkinter
from tkinter import ttk
from pathlib import Path
from PIL import Image, ImageTk
import LLaVA_summarize
import ffmpeg_transcribe
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
oneNote_button_image = ImageTk.PhotoImage(Image.open("image/OneNote.png").resize((65,65), Image.LANCZOS))

button_play = tkinter.Button(
    root, image=play_button_image,)
button_pause = tkinter.Button(
    root, image = pause_button_image)
button_reset = tkinter.Button(
    root, image=reset_button_image)
button_oneNote = tkinter.Button(
    root, image = oneNote_button_image)

button_play.place(x=375, y=10, width = 65, height = 65)
button_pause.place(x=375, y=80, width = 65, height = 65)
button_reset.place(x=375, y=150, width = 65, height = 65)
button_oneNote.place(x=375, y=220, width = 65, height = 65)

# Button Functions
running = False
video_path = "capture.mkv"
transcript_prefix = "transcripts/run" 

def AI_worker(raw_txt_path, frame_paths):
    final_md = LLaVA_summarize.complete(
        raw_txt_path, 
        out_path="transcripts/final_transcript_long.txt",
        frame_paths = frame_paths
    )
    def update_ui():
        deletePanel()
        text.insert("end", final_md)
        button_play.config(state="normal", relief="raised")
        button_pause.config(state="normal", relief="raised")
    root.after(0, update_ui)
    
def press_play():
    global running
    if running:
        return
    running = True
    button_play.config(relief="sunken", state="disabled")
    button_pause.config(state="active", relief="raised")
    # threading.Thread(target=_worker, daemon=True).start()
    ffmpeg_transcribe.start_screen_recording_ffmpeg(
        out_path = video_path,
        separate_tracks=True
    )

def stop_and_process():
    global running
    try:
        raw_txt_path, frames = ffmpeg_transcribe.stop_recording_and_transcribe(
            video_path=video_path,
            transcript_prefix=transcript_prefix,
            separate_tracks=True,
            extract_frames_after=True,     # 👈 turn on frames
            frames_mode="uniform",         # or "scene"
            every_n_seconds=20,            # tune as you like
            max_frames=10,                  # keep it small for LLaVA
            scale_width=1280,
        )
    except Exception as e:
        raw_txt_path = None
        def show_err():
            deletePanel()
            text.insert("end", f"Error during stop/transcribe: {e}")
        root.after(0, show_err)

    if raw_txt_path:
        threading.Thread(target=AI_worker, args=(raw_txt_path, frames), daemon=True).start()
    else:
        def restore():
            button_play.config(state="normal", relief="raised")
            button_pause.config(state="normal", relief="raised")
        root.after(0, restore)

    running = False

def press_pause():
    if not running:
        return
    button_pause.config(relief="sunken", state="disabled")
    button_play.config(relief="raised", state="active")
    threading.Thread(target=stop_and_process, daemon=True).start()

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