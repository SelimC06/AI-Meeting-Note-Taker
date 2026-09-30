import multiprocessing

if __name__ == "__main__":
    # freeze_support() MUST run before anything from `app` is imported. In
    # the PyInstaller build every Python helper process -- e.g. the
    # multiprocessing resource tracker, launched as
    # `app-backend -B -S -I -c "from multiprocessing.resource_tracker import main; main(N)"`
    # -- starts by executing this same file. freeze_support() is what turns
    # such a launch into the helper (running its -c code and exiting) instead
    # of a second backend. It used to be called after `from app.server import
    # main`, so every helper first imported app.server -- and with it the
    # startup maintenance, whose orphan sweep adopted the session folder a
    # running /process was still writing as "Recovered recording" (then the
    # job indexed it again under the same id), or deleted it outright.
    multiprocessing.freeze_support()

    from app.server import main

    main()
