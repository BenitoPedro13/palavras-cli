#!/usr/bin/env python3
import argparse
import json
import sys
import tkinter as tk

HANDLE_SIZE = 8
MIN_SIZE = 20


class RegionOverlay:
    def __init__(self, root: tk.Tk, initial_rect):
        self.root = root
        self.screen_w = root.winfo_screenwidth()
        self.screen_h = root.winfo_screenheight()
        self.canvas = tk.Canvas(root, bg="#000000", highlightthickness=0)
        self.canvas.pack(fill="both", expand=True)
        self.rect = initial_rect
        self.mode = None
        self.anchor_x = 0
        self.anchor_y = 0
        self.base_rect = None
        self.result = "CANCELLED"
        self.help_text = (
            "Arraste para criar a area | arraste dentro para mover | arraste bordas para redimensionar | Enter confirma | F tela inteira | Esc cancela"
        )

        self.canvas.bind("<ButtonPress-1>", self.on_press)
        self.canvas.bind("<B1-Motion>", self.on_drag)
        self.canvas.bind("<ButtonRelease-1>", self.on_release)
        self.root.bind("<Return>", self.on_confirm)
        self.root.bind("<Escape>", self.on_cancel)
        self.root.bind("<f>", self.on_fullscreen)
        self.root.bind("<F>", self.on_fullscreen)
        self.root.protocol("WM_DELETE_WINDOW", self.on_cancel)

        self.draw()

    def clamp(self, value, low, high):
        return max(low, min(high, value))

    def normalize_rect(self, rect):
        x1, y1, x2, y2 = rect
        left = min(x1, x2)
        top = min(y1, y2)
        right = max(x1, x2)
        bottom = max(y1, y2)
        left = self.clamp(left, 0, self.screen_w)
        top = self.clamp(top, 0, self.screen_h)
        right = self.clamp(right, 0, self.screen_w)
        bottom = self.clamp(bottom, 0, self.screen_h)
        return [left, top, right, bottom]

    def hit_test(self, x, y):
        if not self.rect:
            return None
        x1, y1, x2, y2 = self.rect
        if x1 > x2:
            x1, x2 = x2, x1
        if y1 > y2:
            y1, y2 = y2, y1
        near_left = abs(x - x1) <= HANDLE_SIZE
        near_right = abs(x - x2) <= HANDLE_SIZE
        near_top = abs(y - y1) <= HANDLE_SIZE
        near_bottom = abs(y - y2) <= HANDLE_SIZE
        inside_x = x1 <= x <= x2
        inside_y = y1 <= y <= y2

        if near_left and near_top:
            return "nw"
        if near_right and near_top:
            return "ne"
        if near_left and near_bottom:
            return "sw"
        if near_right and near_bottom:
            return "se"
        if near_left and inside_y:
            return "w"
        if near_right and inside_y:
            return "e"
        if near_top and inside_x:
            return "n"
        if near_bottom and inside_x:
            return "s"
        if inside_x and inside_y:
            return "move"
        return None

    def on_press(self, event):
        self.anchor_x = event.x
        self.anchor_y = event.y
        self.base_rect = self.rect[:] if self.rect else None
        hit = self.hit_test(event.x, event.y)
        self.mode = hit if hit else "create"
        if self.mode == "create":
            self.rect = [event.x, event.y, event.x, event.y]
        self.draw()

    def on_drag(self, event):
        x = self.clamp(event.x, 0, self.screen_w)
        y = self.clamp(event.y, 0, self.screen_h)
        if self.mode == "create":
            self.rect[2] = x
            self.rect[3] = y
        elif self.mode == "move" and self.base_rect:
            dx = x - self.anchor_x
            dy = y - self.anchor_y
            x1, y1, x2, y2 = self.base_rect
            w = x2 - x1
            h = y2 - y1
            nx1 = self.clamp(x1 + dx, 0, self.screen_w - w)
            ny1 = self.clamp(y1 + dy, 0, self.screen_h - h)
            self.rect = [nx1, ny1, nx1 + w, ny1 + h]
        elif self.mode and self.base_rect:
            x1, y1, x2, y2 = self.base_rect
            if "w" in self.mode:
                x1 = x
            if "e" in self.mode:
                x2 = x
            if "n" in self.mode:
                y1 = y
            if "s" in self.mode:
                y2 = y
            self.rect = [x1, y1, x2, y2]
        self.rect = self.normalize_rect(self.rect)
        self.enforce_min_size()
        self.draw()

    def enforce_min_size(self):
        if not self.rect:
            return
        x1, y1, x2, y2 = self.rect
        if x2 - x1 < MIN_SIZE:
            x2 = min(self.screen_w, x1 + MIN_SIZE)
            x1 = max(0, x2 - MIN_SIZE)
        if y2 - y1 < MIN_SIZE:
            y2 = min(self.screen_h, y1 + MIN_SIZE)
            y1 = max(0, y2 - MIN_SIZE)
        self.rect = [x1, y1, x2, y2]

    def on_release(self, _event):
        self.mode = None
        if self.rect:
            self.rect = self.normalize_rect(self.rect)
            self.enforce_min_size()
        self.draw()

    def draw(self):
        self.canvas.delete("all")
        self.canvas.create_rectangle(
            0, 0, self.screen_w, self.screen_h, fill="#000000", stipple="gray50", outline=""
        )
        self.canvas.create_text(
            20, 20, anchor="nw", text=self.help_text, fill="#ffffff", font=("Helvetica", 14, "bold")
        )
        if self.rect:
            x1, y1, x2, y2 = self.rect
            self.canvas.create_rectangle(x1, y1, x2, y2, outline="#22d3ee", width=3, fill="")
            self.canvas.create_text(
                x1,
                max(26, y1 - 10),
                anchor="sw",
                text=f"{int(x2 - x1)}x{int(y2 - y1)}",
                fill="#22d3ee",
                font=("Helvetica", 12, "bold"),
            )
            for hx, hy in [(x1, y1), (x2, y1), (x1, y2), (x2, y2)]:
                self.canvas.create_rectangle(
                    hx - HANDLE_SIZE,
                    hy - HANDLE_SIZE,
                    hx + HANDLE_SIZE,
                    hy + HANDLE_SIZE,
                    fill="#22d3ee",
                    outline="",
                )

    def on_fullscreen(self, _event=None):
        self.result = "FULLSCREEN"
        self.root.destroy()

    def on_cancel(self, _event=None):
        self.result = "CANCELLED"
        self.root.destroy()

    def on_confirm(self, _event=None):
        if not self.rect:
            self.result = "CANCELLED"
        else:
            x1, y1, x2, y2 = self.normalize_rect(self.rect)
            width = int(x2 - x1)
            height = int(y2 - y1)
            if width < MIN_SIZE or height < MIN_SIZE:
                self.result = "CANCELLED"
            else:
                self.result = json.dumps(
                    {
                        "left": int(x1),
                        "top": int(y1),
                        "width": width,
                        "height": height,
                    }
                )
        self.root.destroy()


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--left", type=int, default=None)
    parser.add_argument("--top", type=int, default=None)
    parser.add_argument("--width", type=int, default=None)
    parser.add_argument("--height", type=int, default=None)
    return parser.parse_args()


def main():
    args = parse_args()
    initial_rect = None
    if (
        args.left is not None
        and args.top is not None
        and args.width is not None
        and args.height is not None
        and args.width > 0
        and args.height > 0
    ):
        initial_rect = [
            args.left,
            args.top,
            args.left + args.width,
            args.top + args.height,
        ]

    root = tk.Tk()
    root.title("OCR Region Picker")
    root.attributes("-fullscreen", True)
    root.attributes("-topmost", True)
    root.configure(bg="#000000")

    overlay = RegionOverlay(root, initial_rect)
    root.mainloop()
    print(overlay.result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
