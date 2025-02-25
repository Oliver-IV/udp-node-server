// Oliver Inzunza | Luisa Morales | Jullian Puerta | Karim Franco

export class Data {
    contentType?: string ;
    content?: string;
    part?: number;
    chunks?: number;

    constructor(contentType?:string, part?: number, chunks?: number, content?: string) {
        this.contentType = contentType ;
        this.content = content ;
        this.part = part ;
        this.chunks = chunks ;
    }
}