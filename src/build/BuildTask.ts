import { RepositorySpec } from "../types/github"
import { Context } from "probot"
import path from "path"
import fs from "fs"
import fse from "fs-extra"
import extract from "extract-zip"
import { Config } from "../types/config"
import { execute } from "../process/process"
import defaultLogger, { uncoloredCustomFormat } from "../logger/logger"
import CallbackTransport from "./CallbackTransport"
import { format } from "winston"

export default class BuildTask {
    private octokit = this.context.octokit
    private readonly controllerWorkingDir = process.env.WORKING_DIR ?? "/home"

    public state: "queued" | "running" | "finished"
    public identifier = `${this.repositorySpec.owner}+${this.repositorySpec.repo}@${this.ref}`

    public onFinish: () => void
    public onStart: () => void
    public onError: (error: any) => void

    public logger = defaultLogger.child({})
    public buildLog: string[] = []

    constructor(
        private repositorySpec: RepositorySpec,
        private ref: string,
        private config: Config,
        private context: Context,
        private previewId?: string
    ) {
        this.logger.add(
            new CallbackTransport({
                format: format.combine(format.splat(), format.align(), uncoloredCustomFormat),
                callback: (message: string) => this.buildLog.push(message)
            })
        )
    }

    async run() {
        const repositoryDir = await this.download()
        this.injectTemplate(repositoryDir)
        const buildDir = await this.build(repositoryDir)
        await this.copy(buildDir)
        this.cleanup(repositoryDir)
    }

    private async download(): Promise<string> {
        this.logger.debug("Downloading zipball archive from repository")
        const { data: arrayBuffer } = await this.octokit.repos.downloadZipballArchive({
            ...this.repositorySpec,
            ref: this.ref
        })

        const workingDir = path.join(
            this.controllerWorkingDir,
            "build",
            this.identifier.replaceAll("/", "_")
        )
        const downloadFile = path.join(workingDir, "zipball.zip")
        this.logger.debug("Working directory is: %s", this.wdf(workingDir))
        this.logger.debug("Downloading archive to: %s", this.wdf(downloadFile))

        if (fs.existsSync(workingDir)) fs.rmdirSync(workingDir, { recursive: true })

        fs.mkdirSync(workingDir, { recursive: true })
        fs.writeFileSync(downloadFile, Buffer.from(arrayBuffer as ArrayBuffer))

        await extract(downloadFile, { dir: workingDir })
        fs.rmSync(downloadFile)

        const repositoryDir = path.join(workingDir, fs.readdirSync(workingDir)[0])
        this.logger.debug("Extracted repository into: %s", this.wdf(repositoryDir))
        return repositoryDir
    }

    private injectTemplate(repositoryDir: string) {
        const templateDir = path.join(
            this.controllerWorkingDir,
            "templates",
            `${this.repositorySpec.owner}+${this.repositorySpec.repo}`
        )

        if (fs.existsSync(templateDir)) {
            this.logger.debug(
                "Copying template from %s into %s",
                this.wdf(templateDir),
                this.wdf(repositoryDir)
            )
            fse.copySync(templateDir, repositoryDir, { recursive: true, overwrite: true })
        } else {
            this.logger.debug("Found no template at %s", this.wdf(templateDir))
        }
    }

    private async build(repositoryDir: string): Promise<string> {
        const env = this.previewId
            ? { PREVIEW_ID: this.previewId, REACT_APP_PREVIEW_ID: this.previewId }
            : {}

        this.logger.debug(
            "Executing %d build commands with environment: %s",
            this.config.commands.length,
            env
        )

        for await (const command of this.config.commands) {
            await execute(command, repositoryDir, env)
        }

        return path.join(repositoryDir, this.config.buildDir)
    }

    private async copy(buildDir: string) {
        const destinationDir = this.previewId
            ? path.join(this.config.destination + "-preview", this.previewId)
            : this.config.destination
        this.logger.debug(
            "Copying build output from %s into %s",
            this.wdf(buildDir),
            this.wdf(destinationDir)
        )

        if (fs.existsSync(destinationDir)) fs.rmdirSync(destinationDir, { recursive: true })
        fs.mkdirSync(destinationDir, { recursive: true })

        fse.copySync(buildDir, destinationDir, { recursive: true, overwrite: true })
    }

    private cleanup(repositoryDir: string) {
        this.logger.debug("Cleaning up repository directory")
        fs.rmdirSync(repositoryDir, { recursive: true })
    }

    private wdf(path: string): string {
        return path.replace(this.controllerWorkingDir, "*")
    }
}
